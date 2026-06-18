-module(shapes).
-export([area/1, perimeter/1]).
-include_lib("stdlib/include/qlc.hrl").

-record(rectangle, {width, height}).

-define(PI, 3.14159).

-type shape() :: #rectangle{}.

-spec area(#rectangle{}) -> number().
area(R) ->
  R#rectangle.width * R#rectangle.height.

perimeter(R) when is_record(R, rectangle) ->
  2 * (R#rectangle.width + R#rectangle.height);
perimeter(_Other) ->
  0.

-ifdef(DEBUG).
internal_debug() -> ok.
-endif.
