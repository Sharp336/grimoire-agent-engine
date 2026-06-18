defmodule Math.Shapes do
  @moduledoc "Shapes and geometry."

  defstruct sides: 0, name: nil

  defprotocol Area do
    def area(shape)
  end

  defimpl Area, for: Math.Shapes do
    def area(shape) do
      shape.sides * 2
    end
  end

  defmacro twice(expr) do
    quote do
      unquote(expr) + unquote(expr)
    end
  end

  defp private_helper(x) do
    x + 1
  end

  def rectangle(a, b) do
    area = a * b
    IO.puts(area)
    inspect(area)
    area
  end
end
