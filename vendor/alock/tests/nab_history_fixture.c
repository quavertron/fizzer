/* Generate a pre-author archive with the same DTOB library as embedded nab. */
#include "../src/nab_embed.c"

static void legacy_types(DtobTypesHeader *types) {
    build_custom_types_nab(types);
    dtob_types_get(types, NAB_METADATA)->num_codes--;
}

int main(int argc, char **argv) {
    if (argc != 4 || strcmp(argv[1], "--legacy")) return alock_nab_main(argc, argv);
    size_t size = 0;
    uint8_t *data = read_file(argv[2], &size);
    if (!data) return 1;
    uint8_t hash[32];
    sha256_hash(data, size, hash);
    DtobTypesHeader types;
    legacy_types(&types);
    DtobValue *ops = dtob_array();
    dtob_array_push(ops, nab_add(data, size));
    size_t length;
    uint8_t *encoded = dtob_encode_chunk(ops, &types, 1, &length);
    free(encoded);
    DtobValue *entry = nab_metadata_construct(0, hash, length, 2, 0, 0, compute_simhash(data, size), NULL, 0);
    dtob_free(entry->elements[--entry->num_elements].data.val);
    DtobValue *root = dtob_array(), *patches = dtob_array(), *metadata = dtob_array();
    dtob_array_push(root, patches);
    dtob_array_push(root, metadata);
    dtob_array_push(patches, ops);
    dtob_array_push(metadata, entry);
    int result = dtob_write_file(argv[3], root, legacy_types);
    dtob_types_cleanup(&types);
    free(data);
    return result;
}
