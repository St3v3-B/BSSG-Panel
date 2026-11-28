package mail

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"time"
)

// ntpEpoch: 1900-01-01 → Unix.
const ntpEpochOffset = 2208988800

func toNTP(t time.Time) uint64 {
	sec := uint64(t.Unix() + ntpEpochOffset)
	frac := uint64(t.Nanosecond()) * (1 << 32) / 1e9
	return sec<<32 | frac
}

func fromNTP(v uint64) time.Time {
	sec := int64(v>>32) - ntpEpochOffset
	nsec := int64((v & 0xffffffff) * 1e9 >> 32)
	return time.Unix(sec, nsec)
}

// NTPOffset doet één SNTP-query (RFC 4330) naar server:123 en geeft de klokafwijking (server − lokaal).
func NTPOffset(ctx context.Context, server string, dial func(context.Context, string, string) (net.Conn, error)) (time.Duration, error) {
	return ntpQuery(ctx, net.JoinHostPort(server, "123"), dial, time.Now)
}

func ntpQuery(ctx context.Context, addr string, dial func(context.Context, string, string) (net.Conn, error), now func() time.Time) (time.Duration, error) {
	conn, err := dial(ctx, "udp", addr)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	}
	req := make([]byte, 48)
	req[0] = 0x23 // LI 0, versie 4, mode 3 (client)
	t1 := now()
	binary.BigEndian.PutUint64(req[40:], toNTP(t1))
	if _, err := conn.Write(req); err != nil {
		return 0, err
	}
	resp := make([]byte, 48)
	n, err := conn.Read(resp)
	t4 := now()
	if err != nil {
		return 0, err
	}
	if n < 48 {
		return 0, errors.New("short NTP response")
	}
	if mode := resp[0] & 0x7; mode != 4 && mode != 5 {
		return 0, errors.New("not an NTP server response")
	}
	if resp[1] == 0 { // stratum 0 = kiss-of-death
		return 0, errors.New("NTP server sent kiss-of-death")
	}
	if binary.BigEndian.Uint64(resp[24:]) != toNTP(t1) {
		return 0, errors.New("NTP response does not match the request")
	}
	t2 := fromNTP(binary.BigEndian.Uint64(resp[32:]))
	t3 := fromNTP(binary.BigEndian.Uint64(resp[40:]))
	return (t2.Sub(t1) + t3.Sub(t4)) / 2, nil
}
