package demo

class Greeter(val name: String) {
	def greet(): String = s"Hi $name"

	val count: Int = 0

	private val threshold: Int = 10
}

trait Friendly {
	def hello(): String
}

object Singleton {
	def run(): Unit = {}

	val Pi: Double = 3.14
}

enum Color {
	case Red, Green, Blue
}

def topLevel(): Int = 1
