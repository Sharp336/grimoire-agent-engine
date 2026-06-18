package geometry

import "core:fmt"

PI :: 3.14159

Color :: enum { Red, Green, Blue }

Point :: struct {
    x: f64,
    y: f64,
}

distance :: proc(p: Point) -> f64 {
    return p.x
}

main :: proc() {
    fmt.println("hi")
}
