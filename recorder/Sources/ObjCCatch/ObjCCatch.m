#import "ObjCCatch.h"

@implementation TractusObjC

+ (BOOL)catching:(NS_NOESCAPE void (^)(void))block error:(NSError *_Nullable *_Nullable)error {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            NSString *text = [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason ?: @""];
            *error = [NSError errorWithDomain:@"tractus.objc" code:1 userInfo:@{NSLocalizedDescriptionKey: text}];
        }
        return NO;
    }
}

@end
