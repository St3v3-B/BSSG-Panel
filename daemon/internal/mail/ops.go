package mail

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	reDomain   = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	reSelector = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	reLocal    = regexp.MustCompile(`^[a-z0-9!#$%&'+=?^_{|}~-]+(?:\.[a-z0-9!#$%&'+=?^_{|}~-]+)*$`)
	reQueueID  = regexp.MustCompile(`^[0-9A-Za-z]{5,32}$`)
)

// ValidDomain: lowercase domeinnaam met minstens één punt.
func ValidDomain(d string) bool { return len(d) <= 253 && reDomain.MatchString(d) }

// ValidSelector: DKIM-selector (één label, lowercase).
func ValidSelector(s string) bool { return reSelector.MatchString(s) }

// ValidAddress: lowercase mailadres local@domein zonder `/`, `*`, `..` of een punt aan begin/eind van het local part.
func ValidAddress(a string) bool {
	l, d, ok := strings.Cut(a, "@")
	return ok && len(l) <= 64 && reLocal.MatchString(l) && ValidDomain(d)
}

// ValidQueueID: Postfix-queue-id (kort hex of lang base-52); "ALL" en "-" zijn uitgesloten.
func ValidQueueID(id string) bool { return reQueueID.MatchString(id) && !strings.EqualFold(id, "all") }

// ContainerState is één mailcontainer in MailStatus.
type ContainerState struct {
	Name   string `json:"name"`
	State  string `json:"state"`
	Health string `json:"health,omitempty"`
}

// QueueCounts telt de wachtrij per soort.
type QueueCounts struct {
	Active   int `json:"active"`
	Deferred int `json:"deferred"`
	Hold     int `json:"hold"`
}

// Status is het MailStatus-schema.
type Status struct {
	Enabled    bool             `json:"enabled"`
	Configured bool             `json:"configured"`
	Hostname   string           `json:"hostname,omitempty"`
	Containers []ContainerState `json:"containers"`
	Queue      QueueCounts      `json:"queue"`
	VmailBytes *int64           `json:"vmail_bytes,omitempty"`
}

// Status geeft de mailcontainers, de wachtrij en de grootte van de vmail-map.
func (s *Service) Status(ctx context.Context) (Status, error) {
	h := s.Hostname()
	st := Status{Configured: h != "", Hostname: h, Containers: []ContainerState{}}
	list, err := s.containers(ctx)
	if err != nil {
		return st, err
	}
	for _, c := range list {
		st.Containers = append(st.Containers, ContainerState{Name: c.Name, State: c.State, Health: c.Health})
		if c.Name == s.cfg.Postfix && c.State == "running" {
			st.Enabled = true
		}
	}
	sort.Slice(st.Containers, func(i, j int) bool { return st.Containers[i].Name < st.Containers[j].Name })
	var wg sync.WaitGroup
	if st.Enabled {
		wg.Add(1)
		go func() {
			defer wg.Done()
			qctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			if items, err := s.Queue(qctx); err == nil {
				for _, it := range items {
					switch it.Queue {
					case "deferred":
						st.Queue.Deferred++
					case "hold":
						st.Queue.Hold++
					default: // active, incoming, maildrop
						st.Queue.Active++
					}
				}
			}
		}()
	}
	if s.running(ctx, s.cfg.Dovecot) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			if out, err := s.exec(dctx, s.cfg.Dovecot, nil, "du", "-sk", s.cfg.VmailDir); err == nil {
				if f := strings.Fields(out); len(f) > 0 {
					if kb, err := strconv.ParseInt(f[0], 10, 64); err == nil {
						b := kb * 1024
						st.VmailBytes = &b
					}
				}
			}
		}()
	}
	wg.Wait()
	return st, nil
}

// Reload herlaadt Postfix, Dovecot en Rspamd (bv. na een nieuw certificaat). Containers die niet draaien
// worden overgeslagen; draait er niets, dan ErrNotRunning.
func (s *Service) Reload(ctx context.Context) error {
	var errs []error
	found := false
	if s.running(ctx, s.cfg.Postfix) {
		found = true
		if _, err := s.exec(ctx, s.cfg.Postfix, nil, "postfix", "reload"); err != nil {
			errs = append(errs, err)
		}
	}
	if s.running(ctx, s.cfg.Dovecot) {
		found = true
		if _, err := s.exec(ctx, s.cfg.Dovecot, nil, "doveadm", "reload"); err != nil {
			errs = append(errs, err)
		}
	}
	if s.running(ctx, s.cfg.Rspamd) {
		found = true
		if err := s.reloadRspamd(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if !found {
		return ErrNotRunning
	}
	return errors.Join(errs...)
}

func (s *Service) reloadRspamd(ctx context.Context) error {
	if _, err := s.exec(ctx, s.cfg.Rspamd, nil, "rspamadm", "control", "reload"); err == nil {
		return nil
	}
	c, err := s.container(ctx, s.cfg.Rspamd)
	if err != nil {
		return err
	}
	return s.dock.Signal(ctx, c.ID, "HUP")
}

// --- DKIM ---

// ParseDKIMKey controleert een PEM-private key (RSA ≥ 1024 bit of Ed25519) en geeft hem in nette PEM-vorm terug.
func ParseDKIMKey(p string) ([]byte, error) {
	if len(p) > 16<<10 {
		return nil, fmt.Errorf("%w: private key too large", ErrInvalid)
	}
	blk, rest := pem.Decode([]byte(strings.TrimSpace(p)))
	if blk == nil || strings.TrimSpace(string(rest)) != "" {
		return nil, fmt.Errorf("%w: private_key_pem is not a single PEM block", ErrInvalid)
	}
	switch blk.Type {
	case "RSA PRIVATE KEY":
		k, err := x509.ParsePKCS1PrivateKey(blk.Bytes)
		if err != nil || k.N.BitLen() < 1024 {
			return nil, fmt.Errorf("%w: invalid RSA private key", ErrInvalid)
		}
	case "PRIVATE KEY":
		k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid PKCS#8 private key", ErrInvalid)
		}
		switch k := k.(type) {
		case *rsa.PrivateKey:
			if k.N.BitLen() < 1024 {
				return nil, fmt.Errorf("%w: RSA key too small", ErrInvalid)
			}
		case ed25519.PrivateKey:
		default:
			return nil, fmt.Errorf("%w: only RSA or Ed25519 keys", ErrInvalid)
		}
	default:
		return nil, fmt.Errorf("%w: unexpected PEM type %q", ErrInvalid, blk.Type)
	}
	return pem.EncodeToMemory(&pem.Block{Type: blk.Type, Bytes: blk.Bytes}), nil
}

const selectorsMap = "selectors.map"

// listDKIM geeft de bestandsnamen in de DKIM-map.
func (s *Service) listDKIM(ctx context.Context) ([]string, error) {
	out, err := s.exec(ctx, s.cfg.Rspamd, nil, "ls", "-1A", "--", s.cfg.DKIMDir)
	if err != nil {
		return nil, err
	}
	return strings.Fields(out), nil
}

func (s *Service) readSelectors(ctx context.Context, files []string) (map[string]string, error) {
	m := map[string]string{}
	found := false
	for _, f := range files {
		if f == selectorsMap {
			found = true
		}
	}
	if !found {
		return m, nil
	}
	out, err := s.exec(ctx, s.cfg.Rspamd, nil, "cat", "--", path.Join(s.cfg.DKIMDir, selectorsMap))
	if err != nil {
		return nil, err
	}
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && !strings.HasPrefix(f[0], "#") {
			m[f[0]] = f[1]
		}
	}
	return m, nil
}

// writeFile schrijft content atomisch naar dir/name in panel-rspamd (tmp + chmod 0640 + chown + mv).
func (s *Service) writeFile(ctx context.Context, name string, content []byte) error {
	dst := path.Join(s.cfg.DKIMDir, name)
	tmp := dst + ".tmp"
	if _, err := s.exec(ctx, s.cfg.Rspamd, strings.NewReader(string(content)), "tee", "--", tmp); err != nil {
		return err
	}
	cleanup := func() { _, _ = s.exec(context.WithoutCancel(ctx), s.cfg.Rspamd, nil, "rm", "-f", "--", tmp) }
	if _, err := s.exec(ctx, s.cfg.Rspamd, nil, "chmod", "0640", "--", tmp); err != nil {
		cleanup()
		return err
	}
	chown := []string{"chown", "--reference=" + s.cfg.DKIMDir, "--", tmp}
	if s.cfg.DKIMOwner != "" {
		chown = []string{"chown", "--", s.cfg.DKIMOwner, tmp}
	}
	if _, err := s.exec(ctx, s.cfg.Rspamd, nil, chown...); err != nil {
		cleanup()
		return err
	}
	if _, err := s.exec(ctx, s.cfg.Rspamd, nil, "mv", "-f", "--", tmp, dst); err != nil {
		cleanup()
		return err
	}
	return nil
}

func (s *Service) writeSelectors(ctx context.Context, m map[string]string) error {
	doms := make([]string, 0, len(m))
	for d := range m {
		doms = append(doms, d)
	}
	sort.Strings(doms)
	var b strings.Builder
	b.WriteString("# managed by panel-daemon: <domain> <selector>\n")
	for _, d := range doms {
		b.WriteString(d + " " + m[d] + "\n")
	}
	return s.writeFile(ctx, selectorsMap, []byte(b.String()))
}

// keyFiles: bestanden <domain>.<selector>.key van precies dit domein (selector zonder punt).
func keyFiles(files []string, domain string) []string {
	var out []string
	for _, f := range files {
		rest, ok := strings.CutPrefix(f, domain+".")
		if !ok {
			continue
		}
		sel, ok := strings.CutSuffix(rest, ".key")
		if ok && ValidSelector(sel) {
			out = append(out, f)
		}
	}
	return out
}

// PutDKIM zet de private key van domain (selector) in het mail-dkim-volume, werkt selectors.map bij en herlaadt
// Rspamd. Oude sleutels van het domein met een andere selector worden daarna verwijderd. De sleutel wordt nooit
// gelogd.
func (s *Service) PutDKIM(ctx context.Context, domain, selector, keyPEM string) error {
	domain, selector = strings.ToLower(domain), strings.ToLower(selector)
	if !ValidDomain(domain) || !ValidSelector(selector) {
		return fmt.Errorf("%w: domain or selector", ErrInvalid)
	}
	key, err := ParseDKIMKey(keyPEM)
	if err != nil {
		return err
	}
	s.dkimMu.Lock()
	defer s.dkimMu.Unlock()
	files, err := s.listDKIM(ctx)
	if err != nil {
		return err
	}
	m, err := s.readSelectors(ctx, files)
	if err != nil {
		return err
	}
	name := domain + "." + selector + ".key"
	if err := s.writeFile(ctx, name, key); err != nil {
		return fmt.Errorf("write dkim key: %w", err)
	}
	m[domain] = selector
	if err := s.writeSelectors(ctx, m); err != nil {
		return fmt.Errorf("write selectors.map: %w", err)
	}
	var old []string
	for _, f := range keyFiles(files, domain) {
		if f != name {
			old = append(old, path.Join(s.cfg.DKIMDir, f))
		}
	}
	if len(old) > 0 {
		if _, err := s.exec(ctx, s.cfg.Rspamd, nil, append([]string{"rm", "-f", "--"}, old...)...); err != nil {
			s.log.Warn("dkim: removing old keys failed", "domain", domain, "err", err)
		}
	}
	s.log.Info("dkim key installed", "domain", domain, "selector", selector)
	return s.reloadRspamd(ctx)
}

// DeleteDKIM haalt het domein uit selectors.map en verwijdert zijn sleutelbestanden (bestaat niets: ook goed).
func (s *Service) DeleteDKIM(ctx context.Context, domain string) error {
	domain = strings.ToLower(domain)
	if !ValidDomain(domain) {
		return fmt.Errorf("%w: domain", ErrInvalid)
	}
	s.dkimMu.Lock()
	defer s.dkimMu.Unlock()
	files, err := s.listDKIM(ctx)
	if err != nil {
		return err
	}
	m, err := s.readSelectors(ctx, files)
	if err != nil {
		return err
	}
	if _, ok := m[domain]; ok {
		delete(m, domain)
		if err := s.writeSelectors(ctx, m); err != nil {
			return fmt.Errorf("write selectors.map: %w", err)
		}
	}
	var del []string
	for _, f := range keyFiles(files, domain) {
		del = append(del, path.Join(s.cfg.DKIMDir, f))
	}
	if len(del) > 0 {
		if _, err := s.exec(ctx, s.cfg.Rspamd, nil, append([]string{"rm", "-f", "--"}, del...)...); err != nil {
			return err
		}
	}
	s.log.Info("dkim key removed", "domain", domain)
	return s.reloadRspamd(ctx)
}

// --- Wachtrij ---

// QueueItem is één bericht in de Postfix-wachtrij.
type QueueItem struct {
	QueueID     string    `json:"queue_id"`
	Queue       string    `json:"queue"`
	Sender      string    `json:"sender"`
	Recipients  []string  `json:"recipients"`
	Size        int64     `json:"size"`
	ArrivalTime time.Time `json:"arrival_time"`
	Reason      string    `json:"reason,omitempty"`
}

type postqueueLine struct {
	QueueName   string `json:"queue_name"`
	QueueID     string `json:"queue_id"`
	ArrivalTime int64  `json:"arrival_time"`
	MessageSize int64  `json:"message_size"`
	Sender      string `json:"sender"`
	Recipients  []struct {
		Address     string `json:"address"`
		DelayReason string `json:"delay_reason"`
	} `json:"recipients"`
}

// ParsePostqueue leest de uitvoer van `postqueue -j` (één JSON-object per regel).
func ParsePostqueue(out string) []QueueItem {
	items := []QueueItem{}
	sc := bufio.NewScanner(strings.NewReader(out))
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		var l postqueueLine
		if json.Unmarshal([]byte(strings.TrimSpace(sc.Text())), &l) != nil || l.QueueID == "" {
			continue
		}
		it := QueueItem{QueueID: l.QueueID, Queue: l.QueueName, Sender: l.Sender, Size: l.MessageSize,
			ArrivalTime: time.Unix(l.ArrivalTime, 0).UTC(), Recipients: []string{}}
		for _, r := range l.Recipients {
			it.Recipients = append(it.Recipients, r.Address)
			if it.Reason == "" && r.DelayReason != "" {
				it.Reason = r.DelayReason
			}
		}
		items = append(items, it)
	}
	return items
}

// Queue geeft de wachtrij (`postqueue -j`).
func (s *Service) Queue(ctx context.Context) ([]QueueItem, error) {
	out, err := s.exec(ctx, s.cfg.Postfix, nil, "postqueue", "-j")
	if err != nil {
		return nil, err
	}
	return ParsePostqueue(out), nil
}

// FlushQueue probeert alle uitgestelde berichten opnieuw (`postqueue -f`).
func (s *Service) FlushQueue(ctx context.Context) error {
	_, err := s.exec(ctx, s.cfg.Postfix, nil, "postqueue", "-f")
	return err
}

// DeleteQueued verwijdert één bericht (`postsuper -d <id>`); ErrNotFound als het er niet (meer) is.
func (s *Service) DeleteQueued(ctx context.Context, id string) error {
	if !ValidQueueID(id) {
		return fmt.Errorf("%w: queue_id", ErrInvalid)
	}
	out, stderr, err := s.execOut(ctx, s.cfg.Postfix, nil, "postsuper", "-d", id)
	if strings.Contains(out+stderr, "Deleted: 0 messages") {
		return ErrNotFound
	}
	return err
}

// --- Mailboxen ---

// QuotaItem is het quotagebruik van één mailbox. LimitBytes nil = onbeperkt; Error is gezet als doveadm de
// mailbox niet kent (`unknown_user`) of faalde.
type QuotaItem struct {
	Address    string `json:"address"`
	UsedBytes  int64  `json:"used_bytes"`
	LimitBytes *int64 `json:"limit_bytes"`
	Error      string `json:"error,omitempty"`
}

// ParseDoveadmQuota leest `doveadm -f json quota get` en geeft het STORAGE-gebruik (KiB → bytes).
func ParseDoveadmQuota(out string) (used int64, limit *int64, ok bool) {
	var rows []map[string]any
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &rows) != nil {
		return 0, nil, false
	}
	num := func(v any) (int64, bool) {
		switch v := v.(type) {
		case string:
			n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return n, err == nil
		case float64:
			return int64(v), true
		}
		return 0, false
	}
	for _, r := range rows {
		if t, _ := r["type"].(string); !strings.EqualFold(t, "STORAGE") {
			continue
		}
		u, _ := num(r["value"])
		used = u * 1024
		if l, ok := num(r["limit"]); ok && l > 0 {
			lb := l * 1024
			limit = &lb
		}
		return used, limit, true
	}
	return 0, nil, false
}

// MaxQuotaAddresses is het maximum aantal adressen per quota-aanvraag.
const MaxQuotaAddresses = 1000

// Quota vraagt het quotagebruik van de mailboxen op (`doveadm -f json quota get -u <adres>`, 4 tegelijk).
func (s *Service) Quota(ctx context.Context, addrs []string) ([]QuotaItem, error) {
	if len(addrs) > MaxQuotaAddresses {
		return nil, fmt.Errorf("%w: at most %d addresses", ErrInvalid, MaxQuotaAddresses)
	}
	for i, a := range addrs {
		addrs[i] = strings.ToLower(strings.TrimSpace(a))
		if !ValidAddress(addrs[i]) {
			return nil, fmt.Errorf("%w: address %q", ErrInvalid, a)
		}
	}
	if _, err := s.container(ctx, s.cfg.Dovecot); err != nil {
		return nil, err
	}
	items := make([]QuotaItem, len(addrs))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, a := range addrs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			it := QuotaItem{Address: a}
			out, err := s.exec(ctx, s.cfg.Dovecot, nil, "doveadm", "-f", "json", "quota", "get", "-u", a)
			var ee *ExecError
			switch {
			case errors.As(err, &ee) && ee.Code == 67: // EX_NOUSER
				it.Error = "unknown_user"
			case err != nil:
				it.Error = trim(err.Error())
			default:
				u, l, ok := ParseDoveadmQuota(out)
				if !ok {
					it.Error = "no_quota"
				}
				it.UsedBytes, it.LimitBytes = u, l
			}
			items[i] = it
		}()
	}
	wg.Wait()
	return items, nil
}

// DeleteMailboxData verwijdert de Maildir van address (<vmail>/<domein>/<local>) nadat de mailbox gewist is.
func (s *Service) DeleteMailboxData(ctx context.Context, address string) error {
	address = strings.ToLower(strings.TrimSpace(address))
	if !ValidAddress(address) {
		return fmt.Errorf("%w: address", ErrInvalid)
	}
	local, domain, _ := strings.Cut(address, "@")
	dir := path.Join(s.cfg.VmailDir, domain, local)
	if path.Dir(path.Dir(dir)) != path.Clean(s.cfg.VmailDir) || path.Base(dir) != local {
		return fmt.Errorf("%w: address", ErrInvalid)
	}
	_, err := s.exec(ctx, s.cfg.Dovecot, nil, "rm", "-rf", "--", dir)
	if err == nil {
		s.log.Info("mailbox data removed", "address", address)
	}
	return err
}
