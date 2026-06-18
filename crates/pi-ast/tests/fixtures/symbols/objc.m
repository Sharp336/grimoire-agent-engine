#import <Foundation/Foundation.h>

enum Direction { North, South, East, West };

@interface Greeter : NSObject
@property (nonatomic, assign) int count;
- (instancetype)initWithCount:(int)count;
- (int)greet;
@end

@implementation Greeter {
	int _count;
}
- (instancetype)initWithCount:(int)count {
	self = [super init];
	if (self) { _count = count; }
	return self;
}
- (int)greet {
	return _count;
}
@end

int main(int argc, char *argv[]) {
	return 0;
}
