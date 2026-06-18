package demo

class Greeter(val name: String) {
	fun greet(): String = "Hi $name"

	val count: Int = 0

	companion object {
		fun make() = Greeter("x")
	}
}

interface Thing {
	fun doIt()
}

enum class Color {
	RED,
	GREEN,
}

object Singleton {
	fun run() {}
}

fun topLevel(): Int = 1
