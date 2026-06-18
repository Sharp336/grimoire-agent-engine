package App::Web;

use strict;
use warnings;

sub greet {
    my ($name) = @_;
    return "Hi $name";
}

sub helper {
    return 1;
}

1;
