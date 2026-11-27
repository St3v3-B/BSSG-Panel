package mcproto

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func statusOf(t *testing.T, rs *Responder) map[string]any {
	t.Helper()
	l, err := Listen("127.0.0.1:0", rs)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	c, err := net.Dial("tcp", l.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = WritePacket(c, 0, AppendHandshake(nil, Handshake{Protocol: 767, Address: "x", Port: 1, NextState: 1}))
	_ = WritePacket(c, 0, nil)
	id, p, err := ReadPacket(bufio.NewReader(c), 1<<20)
	if err != nil || id != 0 {
		t.Fatal(id, err)
	}
	js, err := readString(bytes.NewReader(p), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(js), &m); err != nil {
		t.Fatalf("geen geldige JSON: %v", err)
	}
	return m
}

func pngBytes(w, h int) []byte {
	var b bytes.Buffer
	_ = png.Encode(&b, image.NewRGBA(image.Rect(0, 0, w, h)))
	return b.Bytes()
}

func text(d map[string]any) string {
	var sb strings.Builder
	for _, e := range d["extra"].([]any) {
		sb.WriteString(e.(map[string]any)["text"].(string))
	}
	return sb.String()
}

func TestStyledStatus(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "server.properties"), []byte("motd=x\nmax-players=42\n"), 0o644)
	st := NewStyle(StyleOpts{Name: "Survival", Dir: dir, LogoFallback: true})
	m := statusOf(t, &Responder{MOTD: "plain", Style: st})
	d := m["description"].(map[string]any)
	if got := text(d); got != "☾ Survival is sleeping\n"+"⚡ Join to wake it up • Hosted on BSSG Panel" {
		t.Fatalf("description: %q", got)
	}
	ex := d["extra"].([]any)
	if ex[1].(map[string]any)["bold"] != true || ex[1].(map[string]any)["color"] != "#a99bff" {
		t.Fatalf("naam niet vet/accent: %v", ex[1])
	}
	pl := m["players"].(map[string]any)
	if pl["max"] != float64(42) || pl["online"] != float64(0) || len(pl["sample"].([]any)) != 1 {
		t.Fatalf("players: %v", pl)
	}
	if m["version"].(map[string]any)["protocol"] != float64(767) {
		t.Fatal("protocol niet doorgegeven")
	}
	fav := m["favicon"].(string)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(fav, "data:image/png;base64,"))
	if err != nil || !bytes.Equal(raw, logoPNG) {
		t.Fatal("favicon is niet het logo")
	}
}

func TestStyleDefaultsAndCustomPromo(t *testing.T) {
	st := NewStyle(StyleOpts{Name: "A", Promo: "&#ff8800Hello &lWorld&r!", LogoFallback: false})
	var d map[string]any
	_ = json.Unmarshal(st.Description, &d)
	ex := d["extra"].([]any)
	if ex[3].(map[string]any)["color"] != "#ff8800" || ex[4].(map[string]any)["bold"] != true || ex[5].(map[string]any)["text"] != "!" {
		t.Fatalf("promo: %v", ex[3:])
	}
	if st.Favicon != "" || st.Max != DefaultMax {
		t.Fatalf("favicon %q max %d", st.Favicon, st.Max)
	}
	if !strings.Contains(string(st.Kick), "is starting") || !json.Valid(st.Kick) {
		t.Fatal(string(st.Kick))
	}
}

func TestServerIcon(t *testing.T) {
	dir := t.TempDir()
	own := pngBytes(64, 64)
	p := filepath.Join(dir, "server-icon.png")
	_ = os.WriteFile(p, own, 0o644)
	st := NewStyle(StyleOpts{Name: "A", Dir: dir, LogoFallback: true})
	if st.Favicon != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(own) {
		t.Fatal("eigen icoon niet gebruikt")
	}
	for name, b := range map[string][]byte{"fout formaat": pngBytes(32, 32), "geen png": []byte("hallo"), "te groot": append(pngBytes(64, 64), make([]byte, MaxIconBytes)...)} {
		_ = os.WriteFile(p, b, 0o644)
		if got := NewStyle(StyleOpts{Name: "A", Dir: dir, LogoFallback: true}).Favicon; !strings.Contains(got, base64.StdEncoding.EncodeToString(logoPNG)) {
			t.Fatalf("%s: logo-terugval verwacht", name)
		}
		if got := NewStyle(StyleOpts{Name: "A", Dir: dir}).Favicon; got != "" {
			t.Fatalf("%s: geen favicon verwacht", name)
		}
	}
	// symlink wordt genegeerd
	_ = os.Remove(p)
	other := filepath.Join(t.TempDir(), "x.png")
	_ = os.WriteFile(other, own, 0o644)
	_ = os.Symlink(other, p)
	if NewStyle(StyleOpts{Name: "A", Dir: dir}).Favicon != "" {
		t.Fatal("symlink gevolgd")
	}
}

func TestLogoIs64(t *testing.T) {
	if ReadIcon("/nonexistent") != nil {
		t.Fatal()
	}
	c, err := png.DecodeConfig(bytes.NewReader(logoPNG))
	if err != nil || c.Width != 64 || c.Height != 64 {
		t.Fatal(c, err)
	}
}

func TestStyledKick(t *testing.T) {
	l, err := Listen("127.0.0.1:0", &Responder{Kick: "x", Style: NewStyle(StyleOpts{Name: "Surv"}), Wake: func() {}})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	c, _ := net.Dial("tcp", l.Addr())
	defer c.Close()
	_ = WritePacket(c, 0, AppendHandshake(nil, Handshake{Protocol: 767, Address: "x", Port: 1, NextState: 2}))
	_, p, err := ReadPacket(bufio.NewReader(c), 1<<16)
	if err != nil {
		t.Fatal(err)
	}
	js, _ := readString(bytes.NewReader(p), 1<<16)
	var m map[string]any
	if json.Unmarshal([]byte(js), &m) != nil || !strings.Contains(js, "Surv") || !strings.Contains(js, "reconnect in about a minute") {
		t.Fatal(js)
	}
}
