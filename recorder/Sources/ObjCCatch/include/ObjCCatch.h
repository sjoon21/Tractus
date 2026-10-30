#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface TractusObjC : NSObject

/// block 안에서 던진 Objective-C 예외를 NSError로 바꾼다. Swift의 do/catch는 NSException을 잡지 못해 프로세스가 abort되므로
/// AVFAudio처럼 예외를 던지는 호출(installTap 등)을 감싸 쓴다. Swift에서는 `try TractusObjC.catching { … }`.
+ (BOOL)catching:(NS_NOESCAPE void (^)(void))block error:(NSError *_Nullable *_Nullable)error;

@end

NS_ASSUME_NONNULL_END
