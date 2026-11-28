// githttp is een minimale smart-HTTP git-server (alleen upload-pack, protocol v0) voor de
// deploy-tests. Hij draait in een alpine/git-container op het site-netwerk van de testsite.
// REPO_ROOT: map met bare repo's; TOKEN (optioneel): vereist HTTP Basic met dit wachtwoord.
package main

import (
	"compress/gzip"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func pkt(s string) []byte { return []byte(fmt.Sprintf("%04x%s", len(s)+4, s)) }

func main() {
	root := os.Getenv("REPO_ROOT")
	token := os.Getenv("TOKEN")
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s", r.Method, r.URL.Path)
		if token != "" {
			if _, p, ok := r.BasicAuth(); !ok || p != token {
				w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
		}
		p := filepath.Clean("/" + r.URL.Path)
		switch {
		case strings.HasSuffix(p, "/info/refs") && r.Method == http.MethodGet:
			if r.URL.Query().Get("service") != "git-upload-pack" {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			repo := filepath.Join(root, strings.TrimSuffix(p, "/info/refs"))
			w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
			w.Header().Set("Cache-Control", "no-cache")
			_, _ = w.Write(pkt("# service=git-upload-pack\n"))
			_, _ = w.Write([]byte("0000"))
			cmd := exec.Command("git", "upload-pack", "--stateless-rpc", "--advertise-refs", repo)
			cmd.Stdout, cmd.Stderr = w, os.Stderr
			_ = cmd.Run()
		case strings.HasSuffix(p, "/git-upload-pack") && r.Method == http.MethodPost:
			repo := filepath.Join(root, strings.TrimSuffix(p, "/git-upload-pack"))
			var body io.Reader = r.Body
			if r.Header.Get("Content-Encoding") == "gzip" {
				gz, err := gzip.NewReader(r.Body)
				if err != nil {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				body = gz
			}
			w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
			cmd := exec.Command("git", "upload-pack", "--stateless-rpc", repo)
			cmd.Stdin, cmd.Stdout, cmd.Stderr = body, w, os.Stderr
			_ = cmd.Run()
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	log.Fatal(http.ListenAndServe(":8080", nil))
}
