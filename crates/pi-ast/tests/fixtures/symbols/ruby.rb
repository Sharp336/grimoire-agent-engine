module App
  class Greeter
    def initialize(name)
      @name = name
    end

    def greet
      "Hi #{@name}"
    end

    attr_accessor :count

    MAX = 10
  end

  def self.helper
    1
  end
end

def top_level
  1
end
