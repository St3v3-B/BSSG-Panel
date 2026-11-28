package dbadmin

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"

	"panel/daemon/internal/engine"
)

func TestDialOnlyTheConfiguredContainer(t *testing.T) {
	allowLoopback = true
	t.Cleanup(func() { allowLoopback = false })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Write([]byte("hi"))
			c.Close()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	ctx := context.Background()
	eng := engine.NewFake()
	a := &Admin{Eng: eng, Container: "mdb", RootPassword: "pw", Port: port}

	// Geen container: niet beschikbaar.
	if _, err := a.Dial(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal("zonder container", err)
	}
	id, err := eng.Create(ctx, engine.ContainerConfig{Name: "mdb", Image: "mariadb:11"})
	if err != nil {
		t.Fatal(err)
	}
	// Bestaat maar draait niet.
	if _, err := a.Dial(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal("gestopt", err)
	}
	eng.Container(id).IPs = map[string]string{"panel-db": "127.0.0.1"}
	if err := eng.Start(ctx, id); err != nil {
		t.Fatal(err)
	}
	c, err := a.Dial(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(c)
	c.Close()
	if string(b) != "hi" {
		t.Fatalf("%q", b)
	}
	// Een andere container met een ander adres wordt nooit gekozen; ongeldige adressen worden overgeslagen.
	eng.Container(id).IPs = map[string]string{"panel-db": "", "x": "::1", "y": "0.0.0.0", "z": "224.0.0.1"}
	if _, err := a.Dial(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal("ongeldige adressen", err)
	}
	// Zonder rootwachtwoord geen MariaDB-beheer en dus geen tunnel.
	if _, err := (&Admin{Eng: eng, Container: "mdb", Port: port}).Dial(ctx); !errors.Is(err, ErrUnavailable) {
		t.Fatal("zonder wachtwoord", err)
	}
}

func TestContainerIPsOrder(t *testing.T) {
	got := containerIPs(map[string]string{"panel-site-x": "10.0.0.5", "panel-db": "172.20.0.2", "a": "10.0.0.9", "dup": "172.20.0.2", "lo": "127.0.0.1"})
	want := []string{"172.20.0.2", "10.0.0.9"}
	if len(got) < 2 || got[0].String() != want[0] || got[1].String() != want[1] {
		t.Fatal(got)
	}
	for _, ip := range got {
		if ip.IsLoopback() {
			t.Fatal("loopback", got)
		}
	}
}
