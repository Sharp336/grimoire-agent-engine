# syntax=docker/dockerfile:1
FROM ubuntu:22.04 AS builder
WORKDIR /src
RUN apt-get update && apt-get install -y build-essential
COPY . .
RUN make build

FROM alpine:3.19 AS runtime
WORKDIR /app
COPY --from=builder /src/out /app/out
CMD ["/app/out"]
