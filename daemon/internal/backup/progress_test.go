package backup

import (
	"errors"
	"testing"
	"time"
)

func TestETA(t *testing.T) {
	if eta(0, 100, time.Second) != nil || eta(10, 0, time.Second) != nil || eta(10, 100, 100*time.Millisecond) != nil {
		t.Fatal("onbekend moet nil zijn")
	}
	if e := eta(25, 100, 10*time.Second); e == nil || *e != 30 {
		t.Fatalf("25 van 100 in 10 s: %v", e)
	}
	if e := eta(120, 100, time.Second); e == nil || *e != 0 {
		t.Fatalf("voorbij het totaal: %v", e)
	}
}

func TestCancelRules(t *testing.T) {
	s := &Service{}
	cancelled := 0
	j := s.begin("u1", 7, "restore", PhaseStopping, func() { cancelled++ })
	if j == nil || s.begin("u1", 8, "backup", PhasePreparing, func() {}) != nil {
		t.Fatal("tweede job voor dezelfde server mag niet")
	}
	if err := s.Cancel("u1", 8); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("ander id: %v", err)
	}
	if err := s.Cancel("u2", 7); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("andere server: %v", err)
	}
	// Herstel tijdens het omwisselen: niet meer te annuleren.
	if err := j.enter(PhaseDownloading, 1000); err != nil {
		t.Fatal(err)
	}
	j.bytes.Store(500)
	p, ok := s.Progress("u1")
	if !ok || p.Phase != PhaseDownloading || p.Percent != 49 || p.TotalBytes != 1000 || !p.Cancellable || p.Operation != "restore" {
		t.Fatalf("voortgang: %+v", p)
	}
	if err := j.advance(PhaseApplying); err != nil {
		t.Fatal(err)
	}
	if err := s.Cancel("u1", 7); !errors.Is(err, ErrNotCancellable) {
		t.Fatalf("tijdens applying: %v", err)
	}
	if p, _ := s.Progress("u1"); p.Cancellable || p.Percent != 99 || p.Bytes != 500 {
		t.Fatalf("applying: %+v", p)
	}
	s.end("u1")
	if _, ok := s.Progress("u1"); ok {
		t.Fatal("job moet weg zijn")
	}

	// Backup: annuleren, daarna kan de volgende fase niet meer beginnen.
	j = s.begin("u1", 9, "backup", PhasePreparing, func() { cancelled++ })
	if err := s.Cancel("u1", 9); err != nil || cancelled != 1 || !j.isCancelled() {
		t.Fatalf("annuleren: %v %d", err, cancelled)
	}
	if err := s.Cancel("u1", 9); err != nil || cancelled != 1 {
		t.Fatal("tweede keer annuleren is een no-op")
	}
	if err := j.enter(PhaseArchiving, 10); !errors.Is(err, errCancelled) {
		t.Fatalf("enter na annuleren: %v", err)
	}
	if err := j.advance(PhaseFinishing); !errors.Is(err, errCancelled) {
		t.Fatalf("advance na annuleren: %v", err)
	}
	// Een backup die al aan het afronden is, niet.
	s.end("u1")
	j = s.begin("u1", 10, "backup", PhaseArchiving, func() {})
	_ = j.advance(PhaseFinishing)
	if err := s.Cancel("u1", 10); !errors.Is(err, ErrNotCancellable) {
		t.Fatalf("finishing: %v", err)
	}
}
