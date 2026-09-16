static int cmd_patch(const char *nab_filename, const char *submission_filename, int is_new, const char *author) {
    size_t author_len = author ? strlen(author) : 0;
    if (nab_author_validate((const uint8_t *)author, author_len)) return 1;
    DEBUG_TIME_START(total);
    DEBUG_TIME_START(rf);
    size_t nlen = 0;
    uint8_t *newd = read_file(submission_filename, &nlen);
    if (!newd) return 1;
    DEBUG_TIME_PRINT(rf, "read_file", " (%zu bytes)", nlen);

    DEBUG_TIME_START(hsh);
    uint8_t sha256[32];
    sha256_hash(newd, nlen, sha256);
    DEBUG_TIME_PRINT(hsh, "hash_sha256", "");

    DtobTypesHeader th;
    build_custom_types_nab(&th);

    uint8_t *prev = NULL;
    size_t prev_len = 0;
    int full = 0;
    uint64_t last_full = 0;
    uint64_t index = 0;
    uint64_t byte_start_pos = 0;

    DtobValue *metadata = NULL;
    uint64_t patches_base = 0;

    int needs_migration = 0;

    if (is_new) {
        full = 1;
    } else {
        /* read types header from start */
        DEBUG_TIME_START(thdr);
        types_header_result thr = read_types_header(nab_filename);
        if (!thr.buf) { fprintf(stderr, "failed to read types header\n"); free(newd); return 1; }
        patches_base = thr.types_end + 4;

        /* decode file's schema and check for migration */
        DtobTypesHeader file_th;
        dtob_types_init(&file_th);
        dtob_decode_types_only(thr.buf, thr.buf_len, &file_th);
        size_t thdr_bytes = thr.buf_len;
        free(thr.buf);
        DEBUG_TIME_PRINT(thdr, "read_types_header", " (%zu bytes)", thdr_bytes);

        DtobCustomType *file_meta = dtob_types_get(&file_th, NAB_METADATA);
        DtobCustomType *cur_meta = dtob_types_get(&th, NAB_METADATA);
        needs_migration = (file_meta && cur_meta && file_meta->num_codes != cur_meta->num_codes);

        /* read metadata from end — decode with file's schema so all fields survive */
        DEBUG_TIME_START(meta_trailer);
        metadata_result mr = get_metadata(nab_filename);
        if (!mr.base) { fprintf(stderr, "failed to read metadata\n"); dtob_types_cleanup(&file_th); free(newd); return 1; }
        metadata = dtob_decode_raw(mr.match, (size_t)mr.match_len, needs_migration ? &file_th : &th);
        size_t meta_raw_len = (size_t)mr.match_len;
        free(mr.base);
        if (!metadata) { fprintf(stderr, "failed to decode metadata\n"); dtob_types_cleanup(&file_th); free(newd); return 1; }
        DEBUG_TIME_PRINT(meta_trailer, "read_metadata_trailer", " (%zu entries, %zu bytes)", metadata->num_elements, meta_raw_len);

        if (needs_migration) {
            fprintf(stderr, "migrating schema: %zu -> %zu metadata fields\n", file_meta->num_codes, cur_meta->num_codes);
            /* merge file's types into th so unknown fields are preserved */
            merge_types_header(&th, &file_th);
            DtobCustomType *merged_meta = dtob_types_get(&th, NAB_METADATA);
            /* pad every old entry to the merged schema */
            for (size_t i = 0; i < metadata->num_elements; i++)
                pad_metadata_entry(metadata->elements[i].data.val, &th, merged_meta);
        }
        dtob_types_cleanup(&file_th);

        index = metadata->num_elements;
        if (index == 0) {
            fprintf(stderr, "corrupt nab: empty metadata\n");
            dtob_free(metadata); free(newd); dtob_types_cleanup(&th); return 1;
        }
        DtobValue *last_entry = metadata->elements[index-1].data.val;
        const DtobValue *last_pid = dgsvfn(&th, last_entry, "patch_id");
        if (last_pid && last_pid->data && last_pid->data_len >= 32 &&
            memcmp(last_pid->data, sha256, 32) == 0) {
            DEBUG_TIME_PRINT(total, "total elapsed", " (no-op: identical to v%llu)", (unsigned long long)index);
            dtob_free(metadata);
            free(newd);
            dtob_types_cleanup(&th);
            return 0;
        }
        uint64_t last_patch_last_full = dtob_extract_u64(dgsvfn(&th, last_entry, "last_full_patch"));
        byte_start_pos = dtob_extract_u64(dgsvfn(&th, last_entry, "byte_offset")) +
                         dtob_extract_u64(dgsvfn(&th, last_entry, "byte_len"));

        if (index % 50 == 0) {
            last_full = index; full = 1;
        } else {
            /* carry the checkpoint chain forward so rebuilds stay bounded */
            last_full = last_patch_last_full;
            /* reconstruct previous state via pread */
            DEBUG_TIME_START(reconstruct);
            int fd = open(nab_filename, O_RDONLY);
            if (fd < 0) { dtob_free(metadata); free(newd); return 1; }
            int rc = replay_archive(fd, patches_base, metadata, &th, last_patch_last_full,
                                    index, &prev, &prev_len);
            close(fd);
            if (rc) {
                dtob_free(metadata); free(newd); dtob_types_cleanup(&th); return 1;
            }
            DEBUG_TIME_PRINT(reconstruct, "reconstruct_prev", " (%llu patches -> %zu bytes)", (unsigned long long)(index - last_patch_last_full), prev_len);
        }
    }

    /* compute diff */
    DEBUG_TIME_START(diff);
    DtobValue *current_ops = dtob_array();
    if (full || !prev) dtob_array_push(current_ops, nab_add(newd, nlen));
    else diff_build(prev, prev_len, newd, nlen, current_ops);
    DEBUG_TIME_PRINT(diff, "diff_build", " (%zu ops)", current_ops->num_elements);

    /* compute simhash */
    DEBUG_TIME_START(simh);
    uint64_t simhash_val = compute_simhash(newd, nlen);
    DEBUG_TIME_PRINT(simh, "compute_simhash", "");

    /* encode only the new patch */
    DEBUG_TIME_START(enc_patch);
    size_t byte_length;
    uint8_t *patch_encoded = dtob_encode_chunk(current_ops, &th, 1, &byte_length);
    DEBUG_TIME_PRINT(enc_patch, "encode_patch", " (%zu bytes)", byte_length);
    uint64_t byte_off = (index == 0) ? 2 : byte_start_pos;

    if (is_new) {
        /* first patch: write full file normally */
        DtobValue *meta_list = dtob_array();
        DtobValue *patches_list = dtob_array();
        DtobValue *root = dtob_array();
        dtob_array_push(root, patches_list);
        dtob_array_push(root, meta_list);
        dtob_array_push(meta_list, nab_metadata_construct(index, sha256, byte_length,
                        byte_off, last_full, (uint64_t)time(NULL), simhash_val,
                        (const uint8_t *)author, author_len));
        dtob_array_push(patches_list, current_ops);
        DEBUG_TIME_START(disk_write);
        int rc = dtob_write_file(nab_filename, root, build_custom_types_nab);
        DEBUG_TIME_PRINT(disk_write, "disk_write_new", "");
        if (g_debug) fprintf(stderr, "[debug] ----------------------------------------\n");
        DEBUG_TIME_PRINT(total, "total elapsed", "");
        free(patch_encoded); free(prev); free(newd);
        dtob_types_cleanup(&th);
        return rc;
    }

    /* append new metadata entry to the already-decoded metadata */
    dtob_array_push(metadata, nab_metadata_construct(index, sha256, byte_length,
                    byte_off, last_full, (uint64_t)time(NULL), simhash_val,
                    (const uint8_t *)author, author_len));

    /* pad the new entry with defaults for any file-only fields */
    if (needs_migration) {
        DtobCustomType *merged_meta = dtob_types_get(&th, NAB_METADATA);
        pad_metadata_entry(metadata->elements[metadata->num_elements - 1].data.val, &th, merged_meta);
    }

    /* encode the metadata array */
    DEBUG_TIME_START(enc_meta);
    size_t meta_enc_len;
    size_t num_meta_entries = metadata->num_elements;
    uint8_t *meta_encoded = dtob_encode_chunk(metadata, &th, 1, &meta_enc_len);
    dtob_free(metadata);
    DEBUG_TIME_PRINT(enc_meta, "encode_metadata", " (%zu entries -> %zu bytes)", num_meta_entries, meta_enc_len);

    uint8_t close_word[2] = {0xC0, 0x03};

    if (needs_migration) {
        /* full rewrite: new types header + raw patches + new patch + metadata */

        /* read the raw patch region from the old file. It begins with the
         * patches open_arr (metadata byte offsets are relative to it, first
         * patch at offset 2), so it must be copied verbatim, not re-framed. */
        uint8_t *raw_patches = malloc((size_t)byte_start_pos);
        int fd = open(nab_filename, O_RDONLY);
        if (fd < 0 || !raw_patches ||
            pread(fd, raw_patches, (size_t)byte_start_pos, (off_t)patches_base) != (ssize_t)byte_start_pos) {
            if (fd >= 0) close(fd);
            free(raw_patches); free(patch_encoded); free(meta_encoded); free(prev); free(newd);
            dtob_types_cleanup(&th);
            return 1;
        }
        close(fd);

        /* DTOB versions differ in whether an empty root is emitted.
         * Keep exactly the types section, including its closing word. */
        DtobValue *empty = dtob_array();
        size_t preamble_len;
        uint8_t *preamble = dtob_encode_with_types(empty, &th, 0, &preamble_len);
        dtob_free(empty);
        uint64_t types_end = preamble ? track_close(preamble, preamble_len, 10, 1) : 0;
        if (!types_end) {
            free(preamble); free(raw_patches); free(patch_encoded); free(meta_encoded); free(prev); free(newd);
            dtob_types_cleanup(&th);
            return 1;
        }
        preamble_len = (size_t)types_end + 2;

        uint8_t open_arr[2] = {0xC0, 0x01};
        size_t total = preamble_len + 2 + (size_t)byte_start_pos + byte_length + 2 + meta_enc_len + 2;
        uint8_t *filebuf = malloc(total);
        size_t off = 0;
        memcpy(filebuf + off, preamble, preamble_len); off += preamble_len;
        memcpy(filebuf + off, open_arr, 2); off += 2; /* root open; patches open is raw_patches[0..1] */
        memcpy(filebuf + off, raw_patches, (size_t)byte_start_pos); off += (size_t)byte_start_pos;
        memcpy(filebuf + off, patch_encoded, byte_length); off += byte_length;
        memcpy(filebuf + off, close_word, 2); off += 2;
        memcpy(filebuf + off, meta_encoded, meta_enc_len); off += meta_enc_len;
        memcpy(filebuf + off, close_word, 2);

        DEBUG_TIME_START(disk_write);
        fd = open(nab_filename, O_WRONLY | O_TRUNC);
        if (fd < 0) { free(filebuf); free(preamble); free(raw_patches); free(patch_encoded); free(meta_encoded); free(prev); free(newd); dtob_types_cleanup(&th); return 1; }
        ssize_t wr = write(fd, filebuf, total);
        fsync(fd);
        close(fd);
        DEBUG_TIME_PRINT(disk_write, "disk_rewrite_fsync", " (%zu bytes)", total);
        free(filebuf); free(preamble); free(raw_patches);
        if (wr != (ssize_t)total) {
            fprintf(stderr, "nab: short write during migration rewrite\n");
            free(patch_encoded); free(meta_encoded); free(prev); free(newd);
            dtob_types_cleanup(&th);
            return 1;
        }
    } else {
        /* append mode: overwrite from the cut point onward */
        off_t cut_point = (off_t)(patches_base + byte_start_pos);

        size_t tail_len = byte_length + 2 + meta_enc_len + 2;
        uint8_t *tail = malloc(tail_len);
        size_t off = 0;
        memcpy(tail + off, patch_encoded, byte_length); off += byte_length;
        memcpy(tail + off, close_word, 2); off += 2;
        memcpy(tail + off, meta_encoded, meta_enc_len); off += meta_enc_len;
        memcpy(tail + off, close_word, 2);

        DEBUG_TIME_START(disk_write);
        int fd = open(nab_filename, O_WRONLY);
        if (fd < 0) { free(tail); free(patch_encoded); free(meta_encoded); free(prev); free(newd); dtob_types_cleanup(&th); return 1; }
        ssize_t wr = pwrite(fd, tail, tail_len, cut_point);
        ftruncate(fd, cut_point + (off_t)tail_len);
        fsync(fd);
        close(fd);
        DEBUG_TIME_PRINT(disk_write, "disk_write_fsync", " (%zu bytes)", tail_len);
        free(tail);
        if (wr != (ssize_t)tail_len) {
            fprintf(stderr, "nab: short write during append\n");
            free(patch_encoded); free(meta_encoded); free(prev); free(newd);
            dtob_types_cleanup(&th);
            return 1;
        }
    }

    if (g_debug) fprintf(stderr, "[debug] ----------------------------------------\n");
    DEBUG_TIME_PRINT(total, "total elapsed", "");

    free(patch_encoded); free(meta_encoded);
    free(prev); free(newd);
    dtob_free(current_ops);
    dtob_types_cleanup(&th);
    return 0;
}

static int rebuild_to_stream(const char *path, int ver, FILE *out, int emit_output) {
    DEBUG_TIME_START(total);

    struct stat archive_stat;
    if (stat(path, &archive_stat) != 0) {
        if (errno == ENOENT) {
            fprintf(stderr, "nab: archive '%s' does not exist\n", path);
        } else {
            fprintf(stderr, "nab: cannot access archive '%s': %s\n", path, strerror(errno));
        }
        return 1;
    }

    /* decode types header from file without reading the whole thing */
    DEBUG_TIME_START(thdr);
    types_header_result thr = read_types_header(path);
    if (!thr.buf) { fprintf(stderr, "nab: failed to read types header from '%s'\n", path); return 1; }
    DtobTypesHeader th;
    dtob_types_init(&th);
    dtob_decode_types_only(thr.buf, thr.buf_len, &th);
    uint64_t patches_base = thr.types_end + 4;
    size_t thdr_bytes = thr.buf_len;
    free(thr.buf);
    DEBUG_TIME_PRINT(thdr, "read_types_header", " (%zu bytes)", thdr_bytes);

    /* decode metadata from end of file (skips patches entirely) */
    DEBUG_TIME_START(meta_trailer);
    metadata_result mr = get_metadata(path);
    if (!mr.base) { fprintf(stderr, "failed to read metadata\n"); dtob_types_cleanup(&th); return 1; }
    DtobValue *metadata = dtob_decode_raw(mr.match, (size_t)mr.match_len, &th);
    size_t meta_raw_len = (size_t)mr.match_len;
    free(mr.base);
    if (!metadata) { fprintf(stderr, "failed to decode metadata\n"); dtob_types_cleanup(&th); return 1; }
    DEBUG_TIME_PRINT(meta_trailer, "read_metadata_trailer", " (%zu entries, %zu bytes)", metadata->num_elements, meta_raw_len);

    size_t target = (ver <= 0) ? metadata->num_elements : (size_t)ver;
    if (target == 0 || target > metadata->num_elements) {
        fprintf(stderr, "version %zu out of range (1-%zu)\n", target, metadata->num_elements);
        dtob_free(metadata); dtob_types_cleanup(&th); return 1;
    }
    DtobValue *target_entry = metadata->elements[target-1].data.val;

    uint64_t last_full = dtob_extract_u64(dgsvfn(&th, target_entry, "last_full_patch"));

    int fd = open(path, O_RDONLY);
    if (fd < 0) { dtob_free(metadata); dtob_types_cleanup(&th); return 1; }

    uint8_t *res = NULL;
    size_t rlen = 0;
    DEBUG_TIME_START(replay);
    int replay_rc = replay_archive(fd, patches_base, metadata, &th, last_full, target, &res, &rlen);
    close(fd);
    if (replay_rc) {
        fprintf(stderr, "nab: failed to replay patches\n");
        dtob_free(metadata); dtob_types_cleanup(&th); return 1;
    }
    const DtobValue *pid = dgsvfn(&th, target_entry, "patch_id");
    int have_hash = pid && pid->data && pid->data_len >= 32;
    const uint8_t *hash = have_hash ? pid->data : NULL;
    DEBUG_TIME_PRINT(replay, "replay_patches", " (%zu patches -> %zu bytes)", target - last_full, rlen);

    DEBUG_TIME_START(verify);
    uint8_t actual[32];
    sha256_hash(res, rlen, actual);
    if (have_hash && memcmp(actual, hash, 32) != 0) {
        fprintf(stderr, "error: hash mismatch on rebuilt content\n");
        free(res); dtob_free(metadata); dtob_types_cleanup(&th);
        return 1;
    }
    DEBUG_TIME_PRINT(verify, "verify_sha256", " (valid)");

    if (emit_output && rlen > 0 && fwrite(res, 1, rlen, out) != rlen) {
        fprintf(stderr, "nab: failed to write rebuilt content\n");
        free(res); dtob_free(metadata); dtob_types_cleanup(&th);
        return 1;
    }

    if (g_debug) fprintf(stderr, "[debug] ----------------------------------------\n");
    DEBUG_TIME_PRINT(total, "total elapsed", "");

    free(res); dtob_free(metadata); dtob_types_cleanup(&th);
    return 0;
}

static int cmd_rebuild(const char *path, int ver) {
    return rebuild_to_stream(path, ver, stdout, !g_debug);
}

static void cleanup_diff_temp(const char *left_path, const char *right_path,
                              const char *temp_dir) {
    if (left_path) unlink(left_path);
    if (right_path) unlink(right_path);
    if (temp_dir) rmdir(temp_dir);
}

static int current_path_from_archive(const char *archive_path, char *current_path,
                                     size_t current_path_size) {
    const char *slash = strrchr(archive_path, '/');
    const char *base = slash ? slash + 1 : archive_path;
    size_t dir_len = slash ? (size_t)(slash - archive_path + 1) : 0;
    size_t base_len = strlen(base);

    if (base_len <= 4 || strcmp(base + base_len - 4, ".nab") != 0) {
        fprintf(stderr, "nab: archive name must end in .nab to locate the current file\n");
        return -1;
    }
    base_len -= 4;
    if (base[0] == '.') {
        base++;
        base_len--;
    }
    if (base_len == 0 || dir_len + base_len + 1 > current_path_size) {
        fprintf(stderr, "nab: cannot derive current file path from '%s'\n", archive_path);
        return -1;
    }

    memcpy(current_path, archive_path, dir_len);
    memcpy(current_path + dir_len, base, base_len);
    current_path[dir_len + base_len] = '\0';
    return 0;
}

static int copy_file_to_stream(const char *path, FILE *out) {
    FILE *in = fopen(path, "rb");
    if (!in) {
        fprintf(stderr, "nab: cannot read current file '%s': %s\n", path, strerror(errno));
        return 1;
    }

    uint8_t buffer[16384];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), in)) > 0) {
        if (fwrite(buffer, 1, count, out) != count) {
            fprintf(stderr, "nab: failed to write temporary file\n");
            fclose(in);
            return 1;
        }
    }
    if (ferror(in)) {
        fprintf(stderr, "nab: failed to read current file '%s'\n", path);
        fclose(in);
        return 1;
    }
    if (fclose(in) != 0) {
        fprintf(stderr, "nab: failed to close current file '%s'\n", path);
        return 1;
    }
    return 0;
}

static int cmd_diff(const char *path, int version_count, int from_ver, int to_ver) {
    char current_path[PATH_MAX];
    if (version_count < 2 &&
        current_path_from_archive(path, current_path, sizeof(current_path)) != 0) {
        return 1;
    }

    char temp_dir[] = "/tmp/nab-diff-XXXXXX";
    int placeholder = mkstemp(temp_dir);
    if (placeholder < 0) {
        fprintf(stderr, "nab: failed to create temporary directory: %s\n", strerror(errno));
        return 1;
    }
    close(placeholder);
    if (unlink(temp_dir) != 0 || mkdir(temp_dir, 0700) != 0) {
        fprintf(stderr, "nab: failed to create temporary directory: %s\n", strerror(errno));
        unlink(temp_dir);
        return 1;
    }

    char left_name[64], right_name[64];
    if (version_count == 0) {
        snprintf(left_name, sizeof(left_name), "latest-version");
        snprintf(right_name, sizeof(right_name), "working-copy");
    } else if (version_count == 1) {
        snprintf(left_name, sizeof(left_name), "version-%d", from_ver);
        snprintf(right_name, sizeof(right_name), "working-copy");
    } else if (from_ver == to_ver) {
        snprintf(left_name, sizeof(left_name), "version-%d-from", from_ver);
        snprintf(right_name, sizeof(right_name), "version-%d-to", to_ver);
    } else {
        snprintf(left_name, sizeof(left_name), "version-%d", from_ver);
        snprintf(right_name, sizeof(right_name), "version-%d", to_ver);
    }

    char left_path[PATH_MAX], right_path[PATH_MAX];
    int left_len = snprintf(left_path, sizeof(left_path), "%s/%s", temp_dir, left_name);
    int right_len = snprintf(right_path, sizeof(right_path), "%s/%s", temp_dir, right_name);
    if (left_len < 0 || (size_t)left_len >= sizeof(left_path) ||
        right_len < 0 || (size_t)right_len >= sizeof(right_path)) {
        fprintf(stderr, "nab: temporary path is too long\n");
        cleanup_diff_temp(NULL, NULL, temp_dir);
        return 1;
    }

    FILE *left = fopen(left_path, "wb");
    if (!left) {
        fprintf(stderr, "nab: failed to create temporary file: %s\n", strerror(errno));
        cleanup_diff_temp(NULL, NULL, temp_dir);
        return 1;
    }
    int left_version = version_count == 0 ? -1 : from_ver;
    int rc = rebuild_to_stream(path, left_version, left, 1);
    if (fclose(left) != 0 && rc == 0) rc = 1;
    if (rc != 0) {
        cleanup_diff_temp(left_path, NULL, temp_dir);
        return rc;
    }

    FILE *right = fopen(right_path, "wb");
    if (!right) {
        fprintf(stderr, "nab: failed to create temporary file: %s\n", strerror(errno));
        cleanup_diff_temp(left_path, NULL, temp_dir);
        return 1;
    }
    if (version_count == 2) {
        rc = rebuild_to_stream(path, to_ver, right, 1);
    } else {
        rc = copy_file_to_stream(current_path, right);
    }
    if (fclose(right) != 0 && rc == 0) rc = 1;
    if (rc != 0) {
        cleanup_diff_temp(left_path, right_path, temp_dir);
        return rc;
    }

    fflush(stdout);
    fflush(stderr);
    pid_t child = fork();
    if (child < 0) {
        fprintf(stderr, "nab: failed to start diff: %s\n", strerror(errno));
        cleanup_diff_temp(left_path, right_path, temp_dir);
        return 1;
    }
    if (child == 0) {
        if (chdir(temp_dir) != 0) {
            fprintf(stderr, "nab: failed to enter temporary directory: %s\n", strerror(errno));
            _exit(126);
        }

        execlp("git", "git", "--paginate", "diff", "--no-index", "--",
               left_name, right_name, (char *)NULL);
        if (errno != ENOENT) {
            fprintf(stderr, "nab: failed to run git diff: %s\n", strerror(errno));
            _exit(126);
        }

        execlp("diff", "diff", "-u", left_name, right_name, (char *)NULL);
        if (errno == ENOENT) {
            fprintf(stderr, "nab: neither git nor diff is available in PATH\n");
        } else {
            fprintf(stderr, "nab: failed to run diff: %s\n", strerror(errno));
        }
        _exit(127);
    }

    int status = 0;
    while (waitpid(child, &status, 0) < 0) {
        if (errno == EINTR) continue;
        fprintf(stderr, "nab: failed waiting for diff: %s\n", strerror(errno));
        cleanup_diff_temp(left_path, right_path, temp_dir);
        return 1;
    }

    cleanup_diff_temp(left_path, right_path, temp_dir);
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 1;
}

static int cmd_log(const char *path) {
    DEBUG_TIME_START(total);
    /* decode with the file's own schema so migrated files still read */
    DEBUG_TIME_START(thdr);
    DtobTypesHeader th;
    types_header_result thr = read_types_header(path);
    if (thr.buf) {
        dtob_types_init(&th);
        dtob_decode_types_only(thr.buf, thr.buf_len, &th);
        free(thr.buf);
    } else {
        build_custom_types_nab(&th);
    }
    DEBUG_TIME_PRINT(thdr, "read_types_header", "");

    DEBUG_TIME_START(meta_trailer);
    metadata_result mr = get_metadata(path);
    if (!mr.base) { fprintf(stderr, "failed to read metadata\n"); dtob_types_cleanup(&th); return 1; }
    DtobValue *meta_list = dtob_decode_raw(mr.match, (size_t)mr.match_len, &th);
    size_t meta_raw_len = (size_t)mr.match_len;
    free(mr.base);
    if (!meta_list) { fprintf(stderr, "failed to decode metadata\n"); dtob_types_cleanup(&th); return 1; }
    DEBUG_TIME_PRINT(meta_trailer, "read_metadata_trailer", " (%zu entries, %zu bytes)", meta_list->num_elements, meta_raw_len);

    uint64_t prev_simhash = 0;
    for (size_t i = 0; i < meta_list->num_elements; i++) {
        DtobValue *m = meta_list->elements[i].data.val;
        time_t t = (time_t)dtob_extract_u64(dgsvfn(&th, m, "timestamp"));
        struct tm *tm = localtime(&t);
        char tbuf[32]; strftime(tbuf, sizeof(tbuf), "%Y-%b-%d %H:%M:%S%z", tm);
        DtobValue *sh = dgsvfn(&th, m, "simhash");
        if (sh) {
            uint64_t simhash = dtob_extract_u64(sh);
            int dist = __builtin_popcountll(simhash ^ prev_simhash);
            printf("%zu %s simhash-dist=%d", i, tbuf, (i == 0) ? 0 : dist);
            prev_simhash = simhash;
        } else {
            printf("%zu %s", i, tbuf);
        }
        const DtobValue *entry_author = dgsvfn(&th, m, "author");
        if (entry_author && entry_author->data_len) {
            printf(" author=");
            fwrite(entry_author->data, 1, entry_author->data_len, stdout);
        }
        putchar('\n');
    }
    if (g_debug) fprintf(stderr, "[debug] ----------------------------------------\n");
    DEBUG_TIME_PRINT(total, "total elapsed", "");

    dtob_free(meta_list); dtob_types_cleanup(&th); return 0;
}
