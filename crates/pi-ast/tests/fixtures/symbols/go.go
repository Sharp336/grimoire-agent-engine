package demo

type Greeter struct {
	Count int
}

func (g Greeter) Greet() string {
	msg := "hi"
	return msg
}

func Greet(name string) string {
	prefix := "Hi "
	return prefix + name
}
