VERSION = "1.0"

def greet(name):
	return "Hello, " + name

def outer():
	def inner():
		return 42
	return inner()
