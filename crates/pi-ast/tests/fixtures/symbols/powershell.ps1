# Module sample
$Version = "1.0.0"

function Get-Greeting {
    param([string]$Name)
    return "Hello, $Name"
}

class Person {
    [string]$Name
    [int]$Age

    Person([string]$name, [int]$age) {
        $this.Name = $name
        $this.Age = $age
    }

    [string] GetName() {
        return $this.Name
    }
}

enum Color {
    Red
    Green
    Blue
}
