#include <stdio.h>
#include <math.h>
#include <stdbool.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/types.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <libgen.h>
#include <stdlib.h>

#ifdef __APPLE__
#include <TargetConditionals.h>
#include <CommonCrypto/CommonDigest.h>
#if TARGET_OS_OSX && defined(__arm64__)
#include <arm_neon.h>
#define USE_NEON_OPTIMIZATION 1
#endif

static inline void sha256_hash(const uint8_t *data, size_t len, uint8_t out[32]) {
    CC_SHA256(data, (CC_LONG)len, out);
}
#else
/* Portable pure C11 SHA-256 (zero external dependencies on non-Apple platforms) */
#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define SIGMA0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define SIGMA1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define GAMMA0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ ((x) >> 3))
#define GAMMA1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ ((x) >> 10))

static void sha256_transform_block(uint32_t state[8], const uint8_t data[64]) {
    static const uint32_t K[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    };
    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)data[i * 4] << 24) |
               ((uint32_t)data[i * 4 + 1] << 16) |
               ((uint32_t)data[i * 4 + 2] << 8) |
               ((uint32_t)data[i * 4 + 3]);
    }
    for (int i = 16; i < 64; i++) {
        w[i] = GAMMA1(w[i - 2]) + w[i - 7] + GAMMA0(w[i - 15]) + w[i - 16];
    }
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + SIGMA1(e) + CH(e, f, g) + K[i] + w[i];
        uint32_t t2 = SIGMA0(a) + MAJ(a, b, c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

static void sha256_hash(const uint8_t *data, size_t len, uint8_t out[32]) {
    uint32_t state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };
    size_t i = 0;
    while (i + 64 <= len) {
        sha256_transform_block(state, data + i);
        i += 64;
    }

    uint8_t final_block[64] = {0};
    size_t rem = len - i;
    if (rem > 0) memcpy(final_block, data + i, rem);
    final_block[rem] = 0x80;

    if (rem >= 56) {
        sha256_transform_block(state, final_block);
        memset(final_block, 0, 64);
    }
    uint64_t total_bits = (uint64_t)len * 8;
    for (int j = 0; j < 8; j++) {
        final_block[56 + j] = (uint8_t)(total_bits >> ((7 - j) * 8));
    }
    sha256_transform_block(state, final_block);

    for (int j = 0; j < 8; j++) {
        out[j * 4]     = (uint8_t)(state[j] >> 24);
        out[j * 4 + 1] = (uint8_t)(state[j] >> 16);
        out[j * 4 + 2] = (uint8_t)(state[j] >> 8);
        out[j * 4 + 3] = (uint8_t)(state[j]);
    }
}
#undef ROTR
#undef CH
#undef MAJ
#undef SIGMA0
#undef SIGMA1
#undef GAMMA0
#undef GAMMA1
#endif


void format_dotfile(const char *path, size_t size, char *dest) {
    char *dcopy = strdup(path), *bcopy = strdup(path);
    char *d = dirname(dcopy), *b = basename(bcopy);
    snprintf(dest, size, "%s/.%s.nab", d, b);
    free(dcopy); free(bcopy);
}

static uint8_t *read_file(const char *path, size_t *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); return NULL; }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc((size_t)sz);
    if (buf) fread(buf, 1, (size_t)sz, f);
    fclose(f);
    *out_len = (size_t)sz;
    return buf;
}

static uint64_t dtob_extract_u64(const DtobValue *v) {
    uint64_t val = 0;
    if (!v || !v->data) return 0;
    for (size_t i = 0; i < v->data_len && i < 8; i++) {
        val = (val << 8) | v->data[i];
    }
    return val;
}

typedef struct {
    uint8_t *base;   // The pointer to free()
    uint8_t *match;  // The actual metadata start
    uint64_t match_len;
} metadata_result;

/* Composable NEON 4-byte pattern scan macros */
#if USE_NEON_OPTIMIZATION
#define NEON_MATCH_4(buf,pos,v0,v1,v2,v3,_lo,_hi) do {                     \
    uint8x16_t _h = vandq_u8(                                              \
        vandq_u8(vceqq_u8(vld1q_u8(&(buf)[(pos)]),(v0)),                   \
                 vceqq_u8(vld1q_u8(&(buf)[(pos)+1]),(v1))),                 \
        vandq_u8(vceqq_u8(vld1q_u8(&(buf)[(pos)+2]),(v2)),                 \
                 vceqq_u8(vld1q_u8(&(buf)[(pos)+3]),(v3))));                \
    (_lo)=vgetq_lane_u64(vreinterpretq_u64_u8(_h),0);                      \
    (_hi)=vgetq_lane_u64(vreinterpretq_u64_u8(_h),1);                      \
} while(0)
#define NEON_FIRST_MATCH(p,lo,hi) \
    ((int64_t)((p)+((lo)?(__builtin_ctzll(lo)>>3):(8+(__builtin_ctzll(hi)>>3)))))
#define NEON_LAST_MATCH(p,lo,hi) \
    ((int64_t)((p)+((hi)?(8+(7-(__builtin_clzll(hi)>>3))):(7-(__builtin_clzll(lo)>>3)))))
#define SCAN_FORWARD_4(buf,sz,b0,b1,b2,b3,r) do { (r)=-1;                  \
    uint8x16_t _v0=vdupq_n_u8(b0),_v1=vdupq_n_u8(b1),                     \
               _v2=vdupq_n_u8(b2),_v3=vdupq_n_u8(b3);                      \
    for(size_t _p=0;_p+19<=(sz);_p+=16){ uint64_t _lo,_hi;                  \
        NEON_MATCH_4(buf,_p,_v0,_v1,_v2,_v3,_lo,_hi);                      \
        if(__builtin_expect((_lo|_hi)!=0,0)){(r)=NEON_FIRST_MATCH(_p,_lo,_hi);break;}} \
    if((r)<0) for(size_t _p=((sz)>=19?(sz)-18:0);_p+3<(sz);_p+=2)          \
        if((buf)[_p]==(b0)&&(buf)[_p+1]==(b1)&&(buf)[_p+2]==(b2)&&(buf)[_p+3]==(b3)) \
            {(r)=(int64_t)_p;break;}                                        \
} while(0)
#define SCAN_BACKWARD_4(buf,sz,b0,b1,b2,b3,r) do { (r)=-1;                 \
    uint8x16_t _v0=vdupq_n_u8(b0),_v1=vdupq_n_u8(b1),                     \
               _v2=vdupq_n_u8(b2),_v3=vdupq_n_u8(b3);                      \
    for(size_t _p=((sz)>=19?(sz)-19:0);;_p-=16){ uint64_t _lo,_hi;          \
        NEON_MATCH_4(buf,_p,_v0,_v1,_v2,_v3,_lo,_hi);                      \
        if(__builtin_expect((_lo|_hi)!=0,0)){(r)=NEON_LAST_MATCH(_p,_lo,_hi);break;} \
        if(_p<16)break;}                                                    \
    if((r)<0&&(sz)>=4) for(size_t _p=(sz)-4;;_p-=2)                         \
        {if((buf)[_p]==(b0)&&(buf)[_p+1]==(b1)&&(buf)[_p+2]==(b2)&&(buf)[_p+3]==(b3)) \
            {(r)=(int64_t)_p;break;}if(_p<2)break;}                         \
} while(0)
#else
#define SCAN_FORWARD_4(buf,sz,b0,b1,b2,b3,r) do { (r)=-1;                  \
    for(size_t _p=0;_p+3<(sz);_p+=2)                                       \
        if((buf)[_p]==(b0)&&(buf)[_p+1]==(b1)&&(buf)[_p+2]==(b2)&&(buf)[_p+3]==(b3)) \
            {(r)=(int64_t)_p;break;}                                        \
} while(0)
#define SCAN_BACKWARD_4(buf,sz,b0,b1,b2,b3,r) do { (r)=-1;                 \
    if((sz)>=4) for(size_t _p=(sz)-4;;_p-=2)                                \
        {if((buf)[_p]==(b0)&&(buf)[_p+1]==(b1)&&(buf)[_p+2]==(b2)&&(buf)[_p+3]==(b3)) \
            {(r)=(int64_t)_p;break;}if(_p<2)break;}                         \
} while(0)
#endif

/* Scan buffer for the CLOSE that balances nesting from start_pos.
 * start_pos must point at a control-word high byte. depth_offset is initial depth.
 * Returns byte position of matching CLOSE, or 0 (safe: byte 0 is magic). */
static uint64_t track_close(const uint8_t *buf, size_t len, size_t start_pos, int depth_offset) {
    if (start_pos >= len || !DTOB_IS_CTRL(buf[start_pos]))
        return 0;
    int depth = depth_offset;
    size_t pos = start_pos;
#if USE_NEON_OPTIMIZATION
    static const uint8_t emask[16] = {
        0xFF,0,0xFF,0,0xFF,0,0xFF,0,
        0xFF,0,0xFF,0,0xFF,0,0xFF,0
    };
    uint8x16_t even_mask = vld1q_u8(emask);
    uint8x16_t ctrl_bits = vdupq_n_u8(0xC0);
    while (pos + 15 < len) {
        uint8x16_t data = vld1q_u8(&buf[pos]);
        uint8x16_t masked = vandq_u8(data, ctrl_bits);
        uint8x16_t hits = vceqq_u8(masked, ctrl_bits);
        hits = vandq_u8(hits, even_mask);
        uint64_t lo = vgetq_lane_u64(vreinterpretq_u64_u8(hits), 0);
        uint64_t hi = vgetq_lane_u64(vreinterpretq_u64_u8(hits), 1);
        if (__builtin_expect((lo | hi) != 0, 0)) {
            for (size_t i = 0; i < 16 && pos + i + 1 < len; i += 2) {
                if ((buf[pos + i] & 0xC0) == 0xC0) {
                    uint16_t code = ((buf[pos+i] & 0x1F) << 8) | buf[pos+i+1];
                    if (DTOB_IS_OPEN(code)) depth++;
                    else if (code == DTOB_CLOSE) {
                        if (--depth == 0) return (uint64_t)(pos + i);
                    }
                }
            }
        }
        pos += 16;
    }
#endif
    while (pos + 1 < len) {
        if (DTOB_IS_CTRL(buf[pos])) {
            uint16_t code = ((buf[pos] & 0x1F) << 8) | buf[pos + 1];
            if (DTOB_IS_OPEN(code)) depth++;
            else if (code == DTOB_CLOSE) {
                if (--depth == 0) return (uint64_t)pos;
            }
        }
        pos += 2;
    }
    return 0;
}

typedef struct {
    uint8_t *buf;          // caller must free
    size_t buf_len;        // how much was read
    uint64_t types_end;    // byte position of the types CLOSE word
} types_header_result;

/* Read from start of file in a doubling window (starting at 1024).
 * Returns the buffer containing the types header and the position of its CLOSE.
 * Caller frees buf. On failure, buf is NULL. */
static types_header_result read_types_header(const char *path) {
    types_header_result fail = {NULL, 0, 0};
    int fd = open(path, O_RDONLY);
    if (fd < 0) return fail;

    size_t window = 1024;
    uint8_t *buf = malloc(window);
    if (!buf) { close(fd); return fail; }

    ssize_t nread = pread(fd, buf, window, 0);
    if (nread < 10) { free(buf); close(fd); return fail; }

    /* verify byte 8 is open_types */
    if (!DTOB_IS_CTRL(buf[8]) || (((buf[8] & 0x1F) << 8) | buf[9]) != DTOB_OPEN_TYPES) {
        free(buf); close(fd); return fail;
    }

    while (1) {
        uint64_t pos = track_close(buf, (size_t)nread, 10, 1);
        if (pos != 0) {
            close(fd);
            return (types_header_result){buf, (size_t)nread, pos};
        }
        window *= 2;
        void *tmp = realloc(buf, window);
        if (!tmp) { free(buf); close(fd); return fail; }
        buf = (uint8_t *)tmp;

        nread = pread(fd, buf, window, 0);
        if (nread <= 0) break;
    }
    free(buf); close(fd);
    return fail;
}

/* Read metadata from end of file. Scans backward for the metadata open_arr
 * (pattern: C0 01 followed by NAB_METADATA code C0 15). Doubling window from EOF. */
metadata_result get_metadata(const char *path) {
    struct stat st;
    metadata_result fail = {NULL, NULL, 0};
    if (stat(path, &st) != 0) return fail;

    int fd = open(path, O_RDONLY);
    if (fd < 0) return fail;

    size_t window = 32768; /* metadata is typically small, 32K should cover it */
    if (window > (size_t)st.st_size) window = (size_t)st.st_size;

    uint8_t *buf = malloc(window);
    if (!buf) { close(fd); return fail; }

    while (1) {
        off_t offset = st.st_size - (off_t)window;
        pread(fd, buf, window, offset);

        /* scan backward for C0 01 C0 15 (open_arr + NAB_METADATA) */
        int64_t found;
        SCAN_BACKWARD_4(buf, window, 0xC0, 0x01, 0xC0, 0x15, found);
        if (found >= 0) {
            close(fd);
            return (metadata_result){ buf, &buf[found], (uint64_t)(window - (size_t)found) };
        }

        /* double window */
        if (window >= (size_t)st.st_size) break;
        window *= 2;
        if (window > (size_t)st.st_size) window = (size_t)st.st_size;
        void *tmp = realloc(buf, window);
        if (!tmp) { free(buf); close(fd); return fail; }
        buf = (uint8_t *)tmp;
    }
    free(buf); close(fd);
    return fail;
}
