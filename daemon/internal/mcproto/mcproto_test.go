package mcproto

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestVarInt(t *testing.T) {
	for _, v := range []int32{0, 1, 127, 128, 255, 25565, 2097151, 2147483647, -1, -2147483648} {
		b := AppendVarInt(nil, v)
		got, err := ReadVarInt(bytes.NewReader(b))
		if err != nil || got != v {
			t.Fatalf("%d: %v %d (%x)", v, err, got, b)
		}
	}
	if b := AppendVarInt(nil, 300); !bytes.Equal(b, []byte{0xac, 0x02}) {
		t.Fatalf("%x", b)
	}
	if _, err := ReadVarInt(bytes.NewReader([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0x01})); !errors.Is(err, ErrVarInt) {
		t.Fatal(err)
	}
}

func TestHandshake(t *testing.T) {
	h := Handshake{Protocol: 767, Address: "mc.example.nl", Port: 25565, NextState: 2}
	got, err := ParseHandshake(AppendHandshake(nil, h))
	if err != nil || got != h {
		t.Fatal(err, got)
	}
	bad := AppendHandshake(nil, Handshake{Protocol: 1, Address: "x", Port: 1, NextState: 7})
	if _, err := ParseHandshake(bad); err == nil {
		t.Fatal("next_state 7")
	}
	if _, err := ParseHandshake([]byte{0x01, 0x7f}); err == nil {
		t.Fatal("afgekapt")
	}
}

func TestReadPacketLimits(t *testing.T) {
	big := AppendVarInt(nil, MaxPacket+1)
	if _, _, err := ReadPacket(bufio.NewReader(bytes.NewReader(big)), MaxPacket); !errors.Is(err, ErrTooLarge) {
		t.Fatal(err)
	}
	if _, _, err := ReadPacket(bufio.NewReader(bytes.NewReader([]byte{0})), MaxPacket); !errors.Is(err, ErrBadPkt) {
		t.Fatal(err)
	}
}

func dialSend(t *testing.T, addr string, pkts ...[]byte) (*bufio.Reader, net.Conn) {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	for _, p := range pkts {
		if _, err := c.Write(p); err != nil {
			t.Fatal(err)
		}
	}
	return bufio.NewReader(c), c
}

func pkt(id int32, payload []byte) []byte {
	var b bytes.Buffer
	_ = WritePacket(&b, id, payload)
	return b.Bytes()
}

func TestResponder(t *testing.T) {
	var woke atomic.Int32
	l, err := Listen("127.0.0.1:0", &Responder{MOTD: "slaapt", Kick: "start, kom zo terug", Wake: func() { woke.Add(1) }, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	// Status + ping/pong.
	r, c := dialSend(t, l.Addr(),
		pkt(0, AppendHandshake(nil, Handshake{Protocol: 765, Address: "x", Port: 1, NextState: 1})),
		pkt(0, nil), pkt(1, []byte{1, 2, 3, 4, 5, 6, 7, 8}))
	id, p, err := ReadPacket(r, 1<<16)
	if err != nil || id != 0 {
		t.Fatal(err, id)
	}
	js, _ := readString(bytes.NewReader(p), 1<<16)
	var st struct {
		Version     struct{ Protocol int32 }
		Players     struct{ Max, Online int }
		Description struct{ Text string }
	}
	if err := json.Unmarshal([]byte(js), &st); err != nil || st.Version.Protocol != 765 || st.Players.Max != 0 || st.Description.Text != "slaapt" {
		t.Fatal(err, js)
	}
	id, p, err = ReadPacket(r, 64)
	if err != nil || id != 1 || !bytes.Equal(p, []byte{1, 2, 3, 4, 5, 6, 7, 8}) {
		t.Fatal("pong", err, id, p)
	}
	c.Close()
	if woke.Load() != 0 {
		t.Fatal("status-ping mag niet wekken")
	}

	// Login → disconnect + wekken.
	r, c = dialSend(t, l.Addr(), pkt(0, AppendHandshake(nil, Handshake{Protocol: 765, Address: "x", Port: 1, NextState: 2})))
	id, p, err = ReadPacket(r, 1<<16)
	if err != nil || id != 0 {
		t.Fatal(err, id)
	}
	msg, _ := readString(bytes.NewReader(p), 1<<16)
	if msg != `{"text":"start, kom zo terug"}` || woke.Load() != 1 {
		t.Fatal(msg, woke.Load())
	}
	c.Close()

	// Te groot pakket en onzin: verbinding dicht, geen wekken.
	for _, junk := range [][]byte{AppendVarInt(nil, 1<<20), {0x05, 0x01, 0x02}, pkt(0, AppendHandshake(nil, Handshake{NextState: 9}))} {
		r, c = dialSend(t, l.Addr(), junk)
		if _, err := r.ReadByte(); err == nil {
			t.Fatalf("antwoord op %x", junk)
		}
		c.Close()
	}
	// Stille verbinding wordt na de timeout gesloten.
	r, c = dialSend(t, l.Addr())
	t0 := time.Now()
	if _, err := r.ReadByte(); err == nil || time.Since(t0) > 2500*time.Millisecond {
		t.Fatal("timeout", err, time.Since(t0))
	}
	c.Close()
	if woke.Load() != 1 {
		t.Fatal(woke.Load())
	}

	// Ping-client tegen de responder.
	n, err := Ping(context.Background(), l.Addr())
	if err != nil || n != 0 {
		t.Fatal(n, err)
	}
}

func TestPerIPLimit(t *testing.T) {
	l, err := Listen("127.0.0.1:0", &Responder{Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	var conns []net.Conn
	for i := 0; i < 4; i++ {
		c, _ := net.Dial("tcp", l.Addr())
		conns = append(conns, c)
	}
	time.Sleep(100 * time.Millisecond)
	c, _ := net.Dial("tcp", l.Addr())
	_ = c.SetDeadline(time.Now().Add(time.Second))
	t0 := time.Now()
	if _, err := c.Read(make([]byte, 1)); err == nil || time.Since(t0) > 900*time.Millisecond {
		t.Fatal("vijfde verbinding niet direct gesloten", err)
	}
	for _, c := range append(conns, c) {
		c.Close()
	}
}

func TestPingStatus(t *testing.T) {
	l, err := Listen("127.0.0.1:0", &Responder{MOTD: "slaapt", Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	st, err := PingStatus(context.Background(), l.Addr())
	if err != nil || st.Players.Online != 0 || st.Players.Max < 0 {
		t.Fatal(st, err)
	}
	if _, err := PingStatus(context.Background(), "127.0.0.1:1"); err == nil {
		t.Fatal("verwachtte een fout bij een gesloten poort")
	}
}
