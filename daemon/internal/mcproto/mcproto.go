// Package mcproto spreekt het kleine deel van het Minecraft Java-protocol dat de slaapstand
// nodig heeft: handshake, status (server-list-ping) en een disconnect tijdens login.
// Eigen implementatie op basis van de openbare protocolbeschrijving.
package mcproto

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

// MaxPacket is de grootste pakketlengte die we accepteren (handshake, status, login-start
// zijn allemaal klein).
const MaxPacket = 2048

var (
	ErrVarInt   = errors.New("mcproto: ongeldige VarInt")
	ErrTooLarge = errors.New("mcproto: pakket te groot")
	ErrBadPkt   = errors.New("mcproto: ongeldig pakket")
)

// ReadVarInt leest een VarInt (max 5 bytes).
func ReadVarInt(r io.ByteReader) (int32, error) {
	var v uint32
	for i := 0; i < 5; i++ {
		b, err := r.ReadByte()
		if err != nil {
			return 0, err
		}
		v |= uint32(b&0x7f) << (7 * i)
		if b&0x80 == 0 {
			return int32(v), nil
		}
	}
	return 0, ErrVarInt
}

// AppendVarInt voegt v als VarInt toe aan b.
func AppendVarInt(b []byte, v int32) []byte {
	u := uint32(v)
	for {
		if u&^0x7f == 0 {
			return append(b, byte(u))
		}
		b = append(b, byte(u&0x7f|0x80))
		u >>= 7
	}
}

// AppendString voegt een string met VarInt-lengte toe.
func AppendString(b []byte, s string) []byte {
	b = AppendVarInt(b, int32(len(s)))
	return append(b, s...)
}

// ReadPacket leest één (ongecomprimeerd) pakket: id en de rest van de inhoud.
func ReadPacket(r *bufio.Reader, max int) (int32, []byte, error) {
	n, err := ReadVarInt(r)
	if err != nil {
		return 0, nil, err
	}
	if n <= 0 {
		return 0, nil, ErrBadPkt
	}
	if int(n) > max {
		return 0, nil, ErrTooLarge
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	br := bytes.NewReader(buf)
	id, err := ReadVarInt(br)
	if err != nil {
		return 0, nil, ErrBadPkt
	}
	return id, buf[len(buf)-br.Len():], nil
}

// WritePacket schrijft id + payload met lengte-prefix.
func WritePacket(w io.Writer, id int32, payload []byte) error {
	body := AppendVarInt(nil, id)
	body = append(body, payload...)
	out := AppendVarInt(nil, int32(len(body)))
	_, err := w.Write(append(out, body...))
	return err
}

func readString(r *bytes.Reader, max int) (string, error) {
	n, err := ReadVarInt(r)
	if err != nil || n < 0 || int(n) > max || int(n) > r.Len() {
		return "", ErrBadPkt
	}
	b := make([]byte, n)
	_, _ = io.ReadFull(r, b)
	return string(b), nil
}

// Handshake is het eerste pakket van een client.
type Handshake struct {
	Protocol  int32
	Address   string
	Port      uint16
	NextState int32 // 1 status, 2 login, 3 transfer
}

// ParseHandshake leest de inhoud van pakket 0x00 in de handshake-staat.
func ParseHandshake(p []byte) (Handshake, error) {
	r := bytes.NewReader(p)
	var h Handshake
	var err error
	if h.Protocol, err = ReadVarInt(r); err != nil {
		return h, ErrBadPkt
	}
	if h.Address, err = readString(r, 255*4); err != nil {
		return h, err
	}
	if err := binary.Read(r, binary.BigEndian, &h.Port); err != nil {
		return h, ErrBadPkt
	}
	if h.NextState, err = ReadVarInt(r); err != nil {
		return h, ErrBadPkt
	}
	if h.NextState < 1 || h.NextState > 3 {
		return h, ErrBadPkt
	}
	return h, nil
}

// AppendHandshake maakt de inhoud van een handshake-pakket.
func AppendHandshake(b []byte, h Handshake) []byte {
	b = AppendVarInt(b, h.Protocol)
	b = AppendString(b, h.Address)
	b = binary.BigEndian.AppendUint16(b, h.Port)
	return AppendVarInt(b, h.NextState)
}

// Status is het (deel van het) status-antwoord.
type Status struct {
	Version struct {
		Name     string `json:"name"`
		Protocol int32  `json:"protocol"`
	} `json:"version"`
	Players struct {
		Max    int `json:"max"`
		Online int `json:"online"`
	} `json:"players"`
	Description any `json:"description"`
}

func textJSON(s string) string {
	b, _ := json.Marshal(map[string]string{"text": s})
	return string(b)
}

// Responder beantwoordt verbindingen van slapende servers.
type Responder struct {
	MOTD, Kick string
	// Wake wordt aangeroepen bij een login- of transferpoging.
	Wake    func()
	Timeout time.Duration
}

// Serve handelt één verbinding af en sluit hem.
func (rs *Responder) Serve(c net.Conn) error {
	defer c.Close()
	to := rs.Timeout
	if to == 0 {
		to = 5 * time.Second
	}
	_ = c.SetDeadline(time.Now().Add(to))
	r := bufio.NewReaderSize(c, 512)
	if b, err := r.Peek(1); err != nil || b[0] == 0xFE {
		return err // legacy ping: niet ondersteund
	}
	id, p, err := ReadPacket(r, MaxPacket)
	if err != nil {
		return err
	}
	if id != 0 {
		return ErrBadPkt
	}
	h, err := ParseHandshake(p)
	if err != nil {
		return err
	}
	if h.NextState == 1 {
		if id, _, err = ReadPacket(r, MaxPacket); err != nil || id != 0 {
			return errors.Join(err, ErrBadPkt)
		}
		var st Status
		st.Version.Name = "Sleeping"
		st.Version.Protocol = h.Protocol
		st.Description = map[string]string{"text": rs.MOTD}
		js, _ := json.Marshal(st)
		if err := WritePacket(c, 0, AppendString(nil, string(js))); err != nil {
			return err
		}
		id, p, err := ReadPacket(r, MaxPacket)
		if err != nil {
			return nil // client sloot zonder ping
		}
		if id == 1 && len(p) == 8 {
			return WritePacket(c, 1, p)
		}
		return nil
	}
	// login (2) of transfer (3): disconnect met de melding en de server wekken.
	if rs.Wake != nil {
		rs.Wake()
	}
	return WritePacket(c, 0, AppendString(nil, textJSON(rs.Kick)))
}

// Ping doet een server-list-ping en geeft het aantal spelers online.
func Ping(ctx context.Context, addr string) (int, error) {
	var d net.Dialer
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return 0, err
	}
	defer c.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	} else {
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	}
	host, portS, _ := net.SplitHostPort(addr)
	var port uint16
	_, _ = fmt.Sscanf(portS, "%d", &port)
	if err := WritePacket(c, 0, AppendHandshake(nil, Handshake{Protocol: -1, Address: host, Port: port, NextState: 1})); err != nil {
		return 0, err
	}
	if err := WritePacket(c, 0, nil); err != nil {
		return 0, err
	}
	r := bufio.NewReader(c)
	id, p, err := ReadPacket(r, 1<<20)
	if err != nil {
		return 0, err
	}
	if id != 0 {
		return 0, ErrBadPkt
	}
	js, err := readString(bytes.NewReader(p), 1<<20)
	if err != nil {
		return 0, err
	}
	var st Status
	if err := json.Unmarshal([]byte(js), &st); err != nil {
		return 0, fmt.Errorf("mcproto: status-JSON: %w", err)
	}
	return st.Players.Online, nil
}
