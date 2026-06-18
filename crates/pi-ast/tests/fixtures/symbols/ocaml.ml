module Math = struct
  let pi = 3.14159

  let rec factorial n =
    if n <= 1 then 1 else n * factorial (n - 1)

  let helper x =
    let local = x + 1 in
    local

  type shape = Circle | Rect of int
end

type alias = string

let rec fib n =
  if n <= 1 then n else fib (n - 1) + fib (n - 2)
