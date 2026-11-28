// Package dbadmin beheert klantdatabases op de MariaDB van deze node. De daemon voert de mariadb-client uit
// in de MariaDB-container (docker exec) met het rootwachtwoord uit zijn eigen omgeving: het panel en het
// netwerk zien dat wachtwoord nooit. Namen en wachtwoorden worden gevalideerd voordat ze in SQL komen; de
// SQL gaat via stdin, nooit via een shell.
package dbadmin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"panel/daemon/internal/engine"
)

var (
	// ErrUnavailable: geen MariaDB-container of geen rootwachtwoord.
	ErrUnavailable = errors.New("mariadb unavailable")
	// ErrExists: database of gebruiker bestaat al.
	ErrExists = errors.New("database or user already exists")
	// ErrNotFound: database of gebruiker bestaat niet.
	ErrNotFound = errors.New("database or user not found")
	// ErrInvalid: ongeldige naam of wachtwoord.
	ErrInvalid = errors.New("invalid name or password")
)

var reName = regexp.MustCompile(`^[a-zA-Z0-9_]{1,64}$`)

// ValidName controleert een database- of gebruikersnaam.
func ValidName(s string) bool { return reName.MatchString(s) }

// ValidPassword: 8-128 printbare ASCII-tekens zonder ' en \ (zo hoeft er niets ge-escaped te worden).
func ValidPassword(p string) bool {
	if len(p) < 8 || len(p) > 128 {
		return false
	}
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c < 0x21 || c > 0x7e || c == '\'' || c == '\\' {
			return false
		}
	}
	return true
}

// Admin is de databasebeheerder van een node.
type Admin struct {
	Eng          engine.Engine
	Container    string // containernaam van de MariaDB (MARIADB_CONTAINER)
	RootPassword string // MARIADB_ROOT_PASSWORD
	// Port van MariaDB in de container voor Dial (0 = 3306; alleen tests wijken af).
	Port int
}

// Error draagt de (afgekapte) uitvoer van de client.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func (a *Admin) env() []string { return []string{"MYSQL_PWD=" + a.RootPassword} }

func (a *Admin) ready() error {
	if a == nil || a.RootPassword == "" || a.Container == "" {
		return ErrUnavailable
	}
	return nil
}

// sql voert SQL uit via stdin van de mariadb-client als root.
func (a *Admin) sql(ctx context.Context, query string) (string, error) {
	r, err := a.Eng.ExecStream(ctx, a.Container, engine.ExecIO{
		Cmd:    []string{"mariadb", "--user=root", "--batch", "--skip-column-names", "--default-character-set=utf8mb4"},
		Env:    a.env(),
		Stdin:  strings.NewReader(query),
		Stdout: io.Discard,
	})
	if err != nil {
		if errors.Is(err, engine.ErrNotFound) {
			return "", ErrUnavailable
		}
		return "", fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if r.ExitCode != 0 {
		return r.Stderr, classify(r.Stderr)
	}
	return r.Stderr, nil
}

func classify(stderr string) error {
	switch {
	case strings.Contains(stderr, "ERROR 1007"), strings.Contains(stderr, "ERROR 1396"):
		return ErrExists
	case strings.Contains(stderr, "ERROR 1133"), strings.Contains(stderr, "ERROR 1049"):
		return ErrNotFound
	case strings.Contains(stderr, "ERROR 2002"), strings.Contains(stderr, "ERROR 2013"), strings.Contains(stderr, "ERROR 1045"):
		return fmt.Errorf("%w: %s", ErrUnavailable, trim(stderr))
	}
	return &Error{Msg: trim(stderr)}
}

func trim(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 400 {
		s = s[len(s)-400:]
	}
	return s
}

// Status controleert of MariaDB antwoordt.
func (a *Admin) Status(ctx context.Context) error {
	if err := a.ready(); err != nil {
		return err
	}
	_, err := a.sql(ctx, "SELECT 1;")
	return err
}

// grantPattern: in GRANT is _ een jokerteken; escapen zodat `s1_a` niet ook `s1xa` dekt.
func grantPattern(db string) string { return strings.ReplaceAll(db, "_", `\_`) }

// Create maakt de database en een gebruiker met rechten op alleen die database.
func (a *Admin) Create(ctx context.Context, db, user, password string) error {
	if !ValidName(db) || !ValidName(user) || !ValidPassword(password) {
		return ErrInvalid
	}
	if err := a.ready(); err != nil {
		return err
	}
	// Stapsgewijs, zodat een mislukking alleen weghaalt wat we zelf maakten (een bestaande gebruiker blijft staan).
	if _, err := a.sql(ctx, fmt.Sprintf("CREATE DATABASE `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n", db)); err != nil {
		return err
	}
	rctx := context.WithoutCancel(ctx)
	if _, err := a.sql(ctx, fmt.Sprintf("CREATE USER '%s'@'%%' IDENTIFIED BY '%s';\n", user, password)); err != nil {
		_, _ = a.sql(rctx, fmt.Sprintf("DROP DATABASE IF EXISTS `%s`;\n", db))
		return err
	}
	if _, err := a.sql(ctx, fmt.Sprintf("GRANT ALL PRIVILEGES ON `%s`.* TO '%s'@'%%';\n", grantPattern(db), user)); err != nil {
		_, _ = a.sql(rctx, fmt.Sprintf("DROP USER IF EXISTS '%s'@'%%';\nDROP DATABASE IF EXISTS `%s`;\n", user, db))
		return err
	}
	return nil
}

// SetPassword wijzigt het wachtwoord van een gebruiker.
func (a *Admin) SetPassword(ctx context.Context, user, password string) error {
	if !ValidName(user) || !ValidPassword(password) {
		return ErrInvalid
	}
	if err := a.ready(); err != nil {
		return err
	}
	_, err := a.sql(ctx, fmt.Sprintf("ALTER USER '%s'@'%%' IDENTIFIED BY '%s';\n", user, password))
	if errors.Is(err, ErrExists) { // ERROR 1396 betekent hier: gebruiker bestaat niet
		return ErrNotFound
	}
	return err
}

// Drop verwijdert de database en de gebruiker (bestaat het niet: ook goed).
func (a *Admin) Drop(ctx context.Context, db, user string) error {
	if !ValidName(db) || !ValidName(user) {
		return ErrInvalid
	}
	if err := a.ready(); err != nil {
		return err
	}
	_, err := a.sql(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS `%s`;\nDROP USER IF EXISTS '%s'@'%%';\n", db, user))
	return err
}

var rePmaUser = regexp.MustCompile(`^pma_u[0-9]{1,18}$`)

// systemSchemas krijgen nooit een grant, in welke schrijfwijze ook (MariaDB-schemanamen zijn op Linux hoofdlettergevoelig,
// maar we weigeren alle varianten).
var systemSchemas = map[string]bool{"mysql": true, "information_schema": true, "performance_schema": true, "sys": true}

// ValidPmaUser: alleen `pma_u<getal>` (het phpMyAdmin-account van een panelgebruiker).
func ValidPmaUser(s string) bool { return rePmaUser.MatchString(s) }

// SyncPmaUser zet het phpMyAdmin-account `user` op een nieuw wachtwoord en ALL PRIVILEGES op precies `dbs`
// (geen GRANT OPTION). Het account wordt vervangen (DROP + CREATE), zodat alle oude rechten vervallen.
func (a *Admin) SyncPmaUser(ctx context.Context, user, password string, dbs []string) error {
	if !ValidPmaUser(user) || !ValidPassword(password) {
		return ErrInvalid
	}
	seen := map[string]bool{}
	var q strings.Builder
	fmt.Fprintf(&q, "DROP USER IF EXISTS '%s'@'%%';\nCREATE USER '%s'@'%%' IDENTIFIED BY '%s' WITH MAX_USER_CONNECTIONS 25;\n", user, user, password)
	for _, db := range dbs {
		if !ValidName(db) || systemSchemas[strings.ToLower(db)] {
			return ErrInvalid
		}
		if seen[db] {
			continue
		}
		seen[db] = true
		fmt.Fprintf(&q, "GRANT ALL PRIVILEGES ON `%s`.* TO '%s'@'%%';\n", grantPattern(db), user)
	}
	if err := a.ready(); err != nil {
		return err
	}
	_, err := a.sql(ctx, q.String())
	return err
}

// Exists meldt of de database bestaat.
func (a *Admin) Exists(ctx context.Context, db string) (bool, error) {
	if !ValidName(db) {
		return false, ErrInvalid
	}
	if err := a.ready(); err != nil {
		return false, err
	}
	var out strings.Builder
	r, err := a.Eng.ExecStream(ctx, a.Container, engine.ExecIO{
		Cmd:    []string{"mariadb", "--user=root", "--batch", "--skip-column-names"},
		Env:    a.env(),
		Stdin:  strings.NewReader(fmt.Sprintf("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='%s';\n", db)),
		Stdout: &out,
	})
	if err != nil {
		return false, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if r.ExitCode != 0 {
		return false, classify(r.Stderr)
	}
	return strings.TrimSpace(out.String()) == "1", nil
}

// Dump schrijft een consistente SQL-dump van db naar w. Een fout na de eerste byte betekent een afgekapte dump.
func (a *Admin) Dump(ctx context.Context, db string, w io.Writer) error {
	if !ValidName(db) {
		return ErrInvalid
	}
	if err := a.ready(); err != nil {
		return err
	}
	r, err := a.Eng.ExecStream(ctx, a.Container, engine.ExecIO{
		Cmd:    []string{"mariadb-dump", "--user=root", "--single-transaction", "--skip-lock-tables", "--routines", "--events", "--default-character-set=utf8mb4", "--", db},
		Env:    a.env(),
		Stdout: w,
	})
	if err != nil {
		return fmt.Errorf("dump: %w", err)
	}
	if r.ExitCode != 0 {
		return classify(r.Stderr)
	}
	return nil
}

// Reset leegt een bestaande database (DROP + CREATE met dezelfde naam en tekenset). Rechten op
// databaseniveau staan in mysql.db en blijven bij een DROP DATABASE gewoon staan, dus de gebruiker van de
// site houdt zijn toegang. Voor publiceren: daarna een volledige dump inladen.
func (a *Admin) Reset(ctx context.Context, db string) error {
	if !ValidName(db) {
		return ErrInvalid
	}
	if err := a.ready(); err != nil {
		return err
	}
	ok, err := a.Exists(ctx, db)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	_, err = a.sql(ctx, fmt.Sprintf("DROP DATABASE `%s`;\nCREATE DATABASE `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n", db, db))
	return err
}

// Import laadt een SQL-stroom in een bestaande database.
func (a *Admin) Import(ctx context.Context, db string, in io.Reader) error {
	if !ValidName(db) {
		return ErrInvalid
	}
	if err := a.ready(); err != nil {
		return err
	}
	ok, err := a.Exists(ctx, db)
	if err != nil {
		return err
	}
	if !ok {
		return ErrNotFound
	}
	r, err := a.Eng.ExecStream(ctx, a.Container, engine.ExecIO{
		Cmd:   []string{"mariadb", "--user=root", "--default-character-set=utf8mb4", "--", db},
		Env:   a.env(),
		Stdin: in,
	})
	if err != nil {
		return fmt.Errorf("import: %w", err)
	}
	if r.ExitCode != 0 {
		return classify(r.Stderr)
	}
	return nil
}
