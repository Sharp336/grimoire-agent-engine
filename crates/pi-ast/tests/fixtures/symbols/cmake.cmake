cmake_minimum_required(VERSION 3.20)
project(Hello C)

function(greet name)
    message(STATUS "Hello ${name}")
endfunction()

macro(warn msg)
    message(WARNING "${msg}")
endmacro()

greet("world")
