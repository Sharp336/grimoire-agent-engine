pub fn greet(name: &str) -> String {
	let prefix = "Hi ";
	format!("{prefix}{name}")
}

pub struct Greeter {
	count: u32,
}

impl Greeter {
	pub fn count(&self) -> u32 {
		let n = self.count;
		n
	}
}

pub enum Color {
	Red,
	Green,
}
