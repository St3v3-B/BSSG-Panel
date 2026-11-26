// Command panel-daemon is de node-daemon. Fase 0: alleen het skelet; de daemon-agent
// bouwt de rest (zie daemon/CLAUDE.md). Het contract staat in packages/api/openapi.yaml.
package main

import (
	"fmt"
	"os"
)

var version = "0.0.0-dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version)
		return
	}
	fmt.Fprintln(os.Stderr, "panel-daemon: nog niet geïmplementeerd (fase 0-skelet)")
	os.Exit(1)
}
