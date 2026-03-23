# Stage 0: official Go image — BoringSSL needs Go 1.21+
FROM golang:1.24-bookworm AS go-provider

# Stage 1: Rust builder
FROM rust:1.85-slim AS builder

COPY --from=go-provider /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

RUN apt-get update && apt-get install -y \
    cmake \
    g++ \
    make \
    perl \
    pkg-config \
    libclang-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml ./
COPY src ./src

RUN cargo build --release

# Stage 2: minimal runtime
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/wreq-relay /usr/local/bin/wreq-relay

EXPOSE 3000
CMD ["wreq-relay"]
