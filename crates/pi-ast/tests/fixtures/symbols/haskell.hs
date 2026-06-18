module Symbols where

factorial :: Int -> Int
factorial 0 = 1
factorial n = n * factorial (n - 1)

pi :: Double
pi = 3.14159

data Shape = Circle | Rect

type Name = String

class Drawable a where
  draw :: a -> String

localLet x =
  let double y = y + y
  in double x

localWhere x = double x
  where double y = y + y
