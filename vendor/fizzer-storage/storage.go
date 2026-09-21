package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type RemoteVaultRecord struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Origin string  `json:"origin"`
	Token  string  `json:"token"`
	Role   *string `json:"role,omitempty"`
}

type Connection struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Origin string `json:"origin"`
}

func NormalizeOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("invalid scheme: %s", scheme)
	}
	host := strings.ToLower(u.Host)
	if scheme == "http" && strings.HasSuffix(host, ":80") {
		host = strings.TrimSuffix(host, ":80")
	} else if scheme == "https" && strings.HasSuffix(host, ":443") {
		host = strings.TrimSuffix(host, ":443")
	}
	return fmt.Sprintf("%s://%s", scheme, host), nil
}

func VaultKey(origin, id string) (string, error) {
	norm, err := NormalizeOrigin(origin)
	if err != nil {
		return "", err
	}
	b, err := json.Marshal([]string{norm, id})
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func ReadRemoteVaults(directory string) ([]RemoteVaultRecord, error) {
	records := make(map[string]RemoteVaultRecord)
	add := func(record RemoteVaultRecord) {
		if record.ID == "" || record.Token == "" {
			return
		}
		norm, err := NormalizeOrigin(record.Origin)
		if err != nil {
			return
		}
		record.Origin = norm
		k, err := VaultKey(record.Origin, record.ID)
		if err != nil {
			return
		}
		records[k] = record
	}

	legacyPath := filepath.Join(directory, "remote-vaults.json")
	if data, err := os.ReadFile(legacyPath); err == nil {
		var legacy []RemoteVaultRecord
		if err := json.Unmarshal(data, &legacy); err == nil {
			for _, rec := range legacy {
				add(rec)
			}
		}
	}

	entriesDir := filepath.Join(directory, "remote-vaults")
	if entries, err := os.ReadDir(entriesDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(entriesDir, entry.Name()))
			if err != nil {
				continue
			}
			var rec RemoteVaultRecord
			if err := json.Unmarshal(data, &rec); err == nil {
				add(rec)
			}
		}
	}

	keys := make([]string, 0, len(records))
	for k := range records {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	result := make([]RemoteVaultRecord, 0, len(keys))
	for _, k := range keys {
		result = append(result, records[k])
	}
	return result, nil
}

func SaveRemoteVault(directory string, record RemoteVaultRecord) error {
	norm, err := NormalizeOrigin(record.Origin)
	if err != nil {
		return err
	}
	record.Origin = norm

	k, err := VaultKey(record.Origin, record.ID)
	if err != nil {
		return err
	}

	hash := sha256.Sum256([]byte(k))
	hashHex := hex.EncodeToString(hash[:])

	entriesDir := filepath.Join(directory, "remote-vaults")
	if err := os.MkdirAll(entriesDir, 0700); err != nil {
		return err
	}

	var randomBytes [16]byte
	_, _ = rand.Read(randomBytes[:])
	temporary := filepath.Join(entriesDir, fmt.Sprintf("%s.%x.tmp", hashHex, randomBytes))
	destination := filepath.Join(entriesDir, hashHex+".json")

	data, err := json.Marshal(record)
	if err != nil {
		return err
	}

	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}

	writeErr := func() error {
		if _, err := f.Write(data); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		return os.Rename(temporary, destination)
	}()

	_ = os.Remove(temporary)
	return writeErr
}

func ReadSessions(directory string) (map[string]string, error) {
	sessions := make(map[string]string)

	legacyPath := filepath.Join(directory, "server-sessions.json")
	if data, err := os.ReadFile(legacyPath); err == nil {
		var legacy map[string]string
		if err := json.Unmarshal(data, &legacy); err == nil {
			for k, v := range legacy {
				sessions[k] = v
			}
		}
	}

	entriesDir := filepath.Join(directory, "server-sessions")
	if entries, err := os.ReadDir(entriesDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(entriesDir, entry.Name()))
			if err != nil {
				continue
			}
			var entryMap map[string]string
			if err := json.Unmarshal(data, &entryMap); err == nil {
				for k, v := range entryMap {
					sessions[k] = v
				}
			}
		}
	}

	return sessions, nil
}

func RememberSession(directory, origin, token string) error {
	if strings.TrimSpace(token) == "" {
		return nil
	}

	hash := sha256.Sum256([]byte(origin))
	hashHex := hex.EncodeToString(hash[:])

	entriesDir := filepath.Join(directory, "server-sessions")
	if err := os.MkdirAll(entriesDir, 0700); err != nil {
		return err
	}

	var randomBytes [16]byte
	_, _ = rand.Read(randomBytes[:])
	temporary := filepath.Join(entriesDir, fmt.Sprintf("%s.%x.tmp", hashHex, randomBytes))
	destination := filepath.Join(entriesDir, hashHex+".json")

	data, err := json.Marshal(map[string]string{origin: token})
	if err != nil {
		return err
	}

	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}

	writeErr := func() error {
		if _, err := f.Write(data); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		return os.Rename(temporary, destination)
	}()

	_ = os.Remove(temporary)
	return writeErr
}

func ListConnections(directory string, vaults []RemoteVaultRecord) ([]Connection, error) {
	connections := make([]Connection, 0, len(vaults))
	for _, v := range vaults {
		connections = append(connections, Connection{
			ID:     v.ID,
			Name:   v.Name,
			Origin: v.Origin,
		})
	}

	sessions, err := ReadSessions(directory)
	if err != nil {
		return connections, nil
	}

	origins := make([]string, 0, len(sessions))
	for o := range sessions {
		origins = append(origins, o)
	}
	sort.Strings(origins)

	for _, origin := range origins {
		if origin == "local" {
			continue
		}
		found := false
		for _, c := range connections {
			if c.Origin == origin {
				found = true
				break
			}
		}
		if !found {
			connections = append(connections, Connection{
				ID:     "",
				Name:   "Remote server",
				Origin: origin,
			})
		}
	}
	return connections, nil
}
