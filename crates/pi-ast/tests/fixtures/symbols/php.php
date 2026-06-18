<?php

namespace App\Web {
    class Greeter
    {
        private string $name;

        public function __construct(string $name)
        {
            $this->name = $name;
        }

        public function greet(): string
        {
            return "Hi {$this->name}";
        }

        public string $count = "0";

        public const MAX = 10;
    }

    interface Thing
    {
        public function doIt(): void;
    }

    trait Greetable
    {
        public function hello(): void
        {
        }
    }

    function topLevel(): int
    {
        return 1;
    }
}
