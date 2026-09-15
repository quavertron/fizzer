#include "purrvect.h"
#include <algorithm>
#include <array>
#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
#include <cmath>
#include <sys/ioctl.h>
#include <unistd.h>

static unsigned placement_columns(const std::vector<char> &svg) {
    winsize size{};
    if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &size) != 0 || !size.ws_col || !size.ws_xpixel) return 0;
    std::unique_ptr<PurrvectDocument,decltype(&purrvect_free)> doc(purrvect_load(svg.data(),svg.size()),purrvect_free);
    if (!doc) throw std::runtime_error("cannot parse SVG");
    float width=0, height=0;
    if (purrvect_size(doc.get(),&width,&height)!=PURRVECT_OK) throw std::runtime_error("cannot read SVG dimensions");
    const double columns=std::ceil(static_cast<double>(width)*size.ws_col/size.ws_xpixel);
    return static_cast<unsigned>(std::clamp(columns,1.0,static_cast<double>(size.ws_col)));
}

static std::string base64(const char *p, size_t n) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (size_t i=0; i<n; i+=3) {
        uint32_t x=static_cast<unsigned char>(p[i]) << 16;
        if (i+1<n) x |= static_cast<unsigned char>(p[i+1]) << 8;
        if (i+2<n) x |= static_cast<unsigned char>(p[i+2]);
        out += alphabet[(x>>18)&63]; out += alphabet[(x>>12)&63];
        out += i+1<n ? alphabet[(x>>6)&63] : '=';
        out += i+2<n ? alphabet[x&63] : '=';
    }
    return out;
}
static unsigned dimension(const char *arg, const char *name = "dimensions") {
    std::string s(arg); size_t end=0;
    auto value=std::stoul(s, &end);
    if (end != s.size() || value == 0 || value > PURRVECT_MAX_DIMENSION)
        throw std::runtime_error(std::string(name)+" must be 1..4096");
    return static_cast<unsigned>(value);
}
int main(int argc, char **argv) {
    const char *usage="Usage:\n  purrvect encode [--width COLUMNS] [--height ROWS] [--id IMAGE_ID] FILE.svg > output.apc\n  Use - for SVG input on stdin\n  purrvect render FILE.svg OUTPUT.pam WIDTH HEIGHT\nExperimental SVG transport requires a patched terminal.\n";
    if (argc==1 || (argc==2 && std::string(argv[1])=="--help")) { std::cout << usage; return 0; }
    try {
        bool encode=argc>=3 && std::string(argv[1])=="encode";
        bool render=argc==6 && std::string(argv[1])=="render";
        if (!encode && !render) throw std::runtime_error(usage);
        std::optional<unsigned> requested_columns, requested_rows;
        std::optional<uint32_t> requested_id;
        const char *input_path=nullptr;
        if (encode) {
            for (int i=2; i<argc; ++i) {
                std::string arg(argv[i]);
                if (arg=="--width" || arg=="--height") {
                    if (++i>=argc) throw std::runtime_error(arg+" requires a value");
                    unsigned value=dimension(argv[i],arg.c_str());
                    (arg=="--width" ? requested_columns : requested_rows)=value;
                } else if (arg=="--id") {
                    if (++i>=argc) throw std::runtime_error("--id requires a value");
                    const std::string value(argv[i]);
                    if (value.empty() || value.find_first_not_of("0123456789")!=std::string::npos)
                        throw std::runtime_error("--id must be 1..4294967295");
                    const auto id=std::stoull(value);
                    if (!id || id>UINT32_MAX) throw std::runtime_error("--id must be 1..4294967295");
                    requested_id=static_cast<uint32_t>(id);
                } else if (arg!="-" && !arg.empty() && arg[0]=='-') {
                    throw std::runtime_error("unknown option: "+arg);
                } else if (input_path) {
                    throw std::runtime_error("encode accepts one SVG file");
                } else input_path=argv[i];
            }
            if (!input_path) throw std::runtime_error("encode requires an SVG file");
        } else input_path=argv[2];
        std::ifstream file;
        if (std::string(input_path)!="-") file.open(input_path, std::ios::binary);
        std::istream &input=std::string(input_path)=="-" ? std::cin : file;
        if (!input) throw std::runtime_error("cannot open SVG file");
        std::vector<char> svg(PURRVECT_MAX_BYTES+1);
        input.read(svg.data(), static_cast<std::streamsize>(svg.size()));
        if (input.bad()) throw std::runtime_error("cannot read SVG file (expected a regular file)");
        svg.resize(static_cast<size_t>(input.gcount()));
        if (svg.empty() || svg.size()>PURRVECT_MAX_BYTES) throw std::runtime_error("SVG must be 1 byte to 4 MiB");
        if (encode) {
            // Private f=1001; source vectors are sent unchanged. No PNG conversion.
            std::string output;
            const unsigned columns=requested_columns.value_or(placement_columns(svg));
            const unsigned rows=requested_rows.value_or(0);
            for (size_t i=0; i<svg.size(); i+=3072) {
                size_t n=std::min(size_t(3072),svg.size()-i);
                // An explicit ID lets applications move/delete their own placements.
                output += i==0 ? "\x1b_Ga=T,f=1001,t=d,c="+std::to_string(columns)+",r="+std::to_string(rows)
                    +(requested_id ? ",i="+std::to_string(*requested_id) : "")+",q=2,m=" : "\x1b_Gm=";
                output += i+n<svg.size() ? "1;" : "0;";
                output += base64(svg.data()+i,n)+"\x1b\\";
            }
            std::cout.write(output.data(), static_cast<std::streamsize>(output.size()));
            std::cout.put('\r');
            std::cout.flush();
            if (!std::cout) throw std::runtime_error("cannot write protocol stream");
        } else {
            unsigned w=dimension(argv[4]), h=dimension(argv[5]);
            std::unique_ptr<PurrvectDocument,decltype(&purrvect_free)> doc(purrvect_load(svg.data(),svg.size()),purrvect_free);
            if (!doc) throw std::runtime_error("cannot parse SVG");
            std::vector<uint8_t> pixels(static_cast<size_t>(w)*h*4);
            if (purrvect_render(doc.get(),w,h,pixels.data(),pixels.size())!=PURRVECT_OK) throw std::runtime_error("SVG render failed");
            std::ofstream output(argv[3],std::ios::binary);
            output << "P7\nWIDTH " << w << "\nHEIGHT " << h << "\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n";
            output.write(reinterpret_cast<const char *>(pixels.data()),static_cast<std::streamsize>(pixels.size()));
            output.close();
            if (!output) throw std::runtime_error("cannot write output file");
        }
        return 0;
    } catch (const std::exception &e) { std::cerr << "purrvect: " << e.what() << '\n'; return 1; }
}
