package main

import (
	"encoding/json"
	"testing"
)

func TestHandlePacketDispatchesNamespacedEvent(t *testing.T) {
	c := newSocketIOClient("http://127.0.0.1", "")
	var got string
	c.On("run:delegate", func(args []json.RawMessage, _ func(...any)) {
		got = string(args[0])
	})
	c.handlePacket(`42/runners,["run:delegate",{"runId":7}]`)
	if got != `{"runId":7}` {
		t.Fatalf("run:delegate not dispatched, got %q", got)
	}
}
