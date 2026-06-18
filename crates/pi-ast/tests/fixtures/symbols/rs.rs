pub fn greet(name: &str) -> String {
	let prefix = "Hi ";
	format!("{prefix}{name}")
}

macro_rules! bail {
	($($arg:tt)*) => { panic!($($arg)*) };
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

pub trait Hello {
	fn hello(&self);
}

pub mod network {
	pub const MAX_CONN: usize = 16;
	pub static VERSION: &str = "1.0";
	pub type Id = u64;
}
