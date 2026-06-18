const std = @import("std");

pub fn greet() void {
    std.debug.print("hi\n", .{});
}

pub const Circle = struct {
    radius: f64,

    pub fn area(self: Circle) f64 {
        return 3.14 * self.radius * self.radius;
    }
};

pub const Color = enum {
    red,
    green,
    blue,
};

const LITERAL = 42;

fn helper() void {}
