package proxy

import "errors"

// NewCaddy maakt de echte Router tegen de Caddy admin-API.
// Eigenaar: web-hosting. Fase-0-stub; de signatuur is contract (zie router.go).
func NewCaddy(cfg Config) (Router, error) {
	_ = cfg
	return nil, errors.New("proxy: NewCaddy nog niet geïmplementeerd")
}
