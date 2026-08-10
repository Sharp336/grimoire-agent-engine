// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "stt-nemotron",
    platforms: [.macOS(.v15)],
    products: [
        .executable(name: "stt-nemotron", targets: ["stt-nemotron"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "300165b240c45375add402265f62410b6df33cf1"
        ),
    ],
    targets: [
        .executableTarget(
            name: "stt-nemotron",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/stt-nemotron"
        ),
    ]
)
