FROM rust:1.90-bookworm AS build

WORKDIR /src

COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY vendor ./vendor

RUN cargo build --release
