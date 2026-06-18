# R symbols: functions, constants, variables, and nested closures

add <- function(a, b) {
  a + b
}

const_num <- 42
const_str <- "hello"

result <- add(1, 2)

nested_fn <- function(x) {
  inner <- function(y) {
    y * 2
  }
  inner(x)
}

arrow <- function(x) x + 1

cache <<- list()

cache2 <- 1 -> target
