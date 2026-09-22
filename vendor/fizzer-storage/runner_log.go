package main

import (
	"fmt"
	"os"
	"time"
)

func logf(msg string, args ...any) {
	ts := time.Now().UTC().Format("15:04:05")
	fmt.Fprintf(os.Stdout, "[DesktopRunner %s] %s\n", ts, fmt.Sprintf(msg, args...))
}

func errorLogf(msg string, args ...any) {
	ts := time.Now().UTC().Format("15:04:05")
	fmt.Fprintf(os.Stderr, "[DesktopRunner %s] %s\n", ts, fmt.Sprintf(msg, args...))
}
