# Stage 0: official Go image — BoringSSL needs Go 1.21+, Debian bookworm only ships 1.19
FROM golang:1.24-bookworm AS go-provider

# Stage 1: Rust builder
FROM rust:1.85-slim AS builder

# Borrow Go from the official image
COPY --from=go-provider /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

# BoringSSL C++ build deps
RUN apt-get update && apt-get install -y \
    build-essential cmake perl pkg-config libclang-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml ./
COPY src ./src

RUN cargo build --release

# Stage 2: minimal runtime image
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/wreq-relay /usr/local/bin/wreq-relay

EXPOSE 3000
CMD ["wreq-relay"]
