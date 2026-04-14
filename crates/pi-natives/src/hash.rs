use napi::bindgen_prelude::*;
use napi_derive::napi;
use wyhash_final4::{WyHash64, generics::WyHashVariant};

#[napi]
pub fn wyhash(input: Either<String, Buffer>, seed: Option<i64>) -> u64 {
	let data: &[u8] = match &input {
		Either::A(s) => s.as_bytes(),
		Either::B(buf) => buf.as_ref(),
	};
	WyHash64::with_seed(seed.unwrap_or(0) as u64).hash(data)
}
