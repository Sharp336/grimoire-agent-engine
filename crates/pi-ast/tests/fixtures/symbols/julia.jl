# Julia symbols: modules, functions, structs, abstract types, constants

module Shapes

export area

function area(r::Float64)
    π * r^2
end

struct Circle
    radius::Float64
end

mutable struct Point
    x::Float64
    y::Float64
end

abstract type AbstractShape end

const PI_APPROX = 3.14

function Base.area(c::Circle)
    π * c.radius^2
end

end # module
