# HCL / Terraform outline fixture.

terraform_required_version = ">= 1.5.0"

variable "instance_count" {
  default = 2
  type    = number
}

provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "web" {
  ami           = "ami-12345678"
  instance_type = "t3.micro"

  tags = {
    Name        = "WebServer"
    Environment = "prod"
  }
}

output "instance_ip" {
  value = "10.0.0.1"
}
