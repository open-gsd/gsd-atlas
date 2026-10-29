# M5 targets for author 4

Task context for every query below: You are reading unfamiliar code and checking what the framework offers for one specific need.

1. [a:objc:ARKit:barcode_detection.h:217:ar_barcode_anchor_get_origin_from_anchor_transform]
   framework: ARKit   (top level)
   name: ar_barcode_anchor_get_origin_from_anchor_transform   kind: function
   declaration: function API_AVAILABLE(visionos(2.0)) AR_EXTERN simd_float4x4 ar_barcode_anchor_get_origin_from_anchor_transform(ar_barcode_anchor_t anchor) AR_REFINED_FOR_SWIFT; ; 
   documentation: Get the transform from an anchor to the origin coordinate system. - Parameter anchor: The anchor. - Returns: The origin from anchor transform.

2. [a:objc:ARKit:camera_frame_provider.h:159:ar_camera_video_format_get_frame_size]
   framework: ARKit   (top level)
   name: ar_camera_video_format_get_frame_size   kind: function
   declaration: function API_AVAILABLE(visionos(2.0)) AR_EXTERN CGSize ar_camera_video_format_get_frame_size(ar_camera_video_format_t video_format) AR_REFINED_FOR_SWIFT; ; 
   documentation: Get the frame size for this video format in pixels. - Parameter video_format: The video format. - Returns: The frame size in pixels.

3. [a:swift:CoreVideo::318:CVImageCleanAperture.horizontalOffset]
   framework: CoreVideo   member of: CVImageCleanAperture
   name: horizontalOffset   kind: var
   declaration: var public var horizontalOffset: Swift.Float ; macOS 27.0+
   documentation: (none)

4. [a:swift:FoundationModels::1542:FoundationModels.ContextSizeExceeded.contextSize]
   framework: FoundationModels   member of: ContextSizeExceeded
   name: contextSize   kind: var
   declaration: var public var contextSize: Swift.Int ; macOS 27.0+
   documentation: (none)

5. [a:swift:AppKit::1296:AppKit.WillResignActiveMessage]
   framework: AppKit   (top level)
   name: WillResignActiveMessage   kind: struct
   declaration: struct public struct WillResignActiveMessage { ; macOS 27.0+
   documentation: (none)

6. [a:swift:MetricKit::952:SignpostIntervalMetric]
   framework: MetricKit   (top level)
   name: SignpostIntervalMetric   kind: struct
   declaration: struct public struct SignpostIntervalMetric : Swift.Sendable, Swift.Codable, Swift.Hashable { ; macOS 27.0+
   documentation: (none)

7. [a:objc:AccessoryAccess:AAUSBAccessoryMatchingCriteria.h:15:AAUSBAccessoryMatchingCriteriaInterfaceMatchingOption]
   framework: AccessoryAccess   (top level)
   name: AAUSBAccessoryMatchingCriteriaInterfaceMatchingOption   kind: enum
   declaration: enum typedef NS_ENUM(NSInteger, AAUSBAccessoryMatchingCriteriaInterfaceMatchingOption) { /*! Matching is successful for USB accessories where every criterion/dictionary matches at least one USB interface.  ; macOS 27.0+
   documentation: Options for performing interface matching using interface matching criteria/dictionaries.

8. [a:swift:USDKit::2137:USDStage.OpenOptions.createNew]
   framework: USDKit   member of: USDStage.OpenOptions
   name: createNew   kind: var
   declaration: var public static var createNew: USDKit.USDStage.USDKit.OpenOptions { ; macOS 27.0+
   documentation: (none)

9. [a:objc:Security:SecCertificate.h:395:SecCertificateCopyPreference]
   framework: Security   (top level)
   name: SecCertificateCopyPreference   kind: function
   declaration: function OSStatus SecCertificateCopyPreference(CFStringRef name, uint32 keyUsage, SecCertificateRef * __nonnull CF_RETURNS_RETAINED certificate) DEPRECATED_IN_MAC_OS_X_VERSION_10_7_AND_LATER;
   documentation: @function SecCertificateCopyPreference Returns the preferred certificate for the specified name and key usage. If a preferred certificate does not exist for the specified name and key usage, NULL is returned. name A string containing an email address (RFC822) or other name for which a preferred certificate is requested. keyUsage A CSSM_KEYUSE key u

10. [a:swift:RealityFoundation::13610:AccessibilityComponent.SupportedActions]
   framework: RealityFoundation   member of: AccessibilityComponent
   name: SupportedActions   kind: struct
   declaration: struct public struct SupportedActions : Swift.OptionSet { ; macOS 12.0+
   documentation: (none)

11. [a:objc:AppKit:NSTextView.h:506:NSTextView.viewportBoundsForTextViewportLayoutController:]
   framework: AppKit   member of: NSTextView
   name: viewportBoundsForTextViewportLayoutController:   kind: method
   declaration: method - (CGRect)viewportBoundsForTextViewportLayoutController:(NSTextViewportLayoutController *)textViewportLayoutController API_AVAILABLE(macos(27.0)) NS_REQUIRES_SUPER; ; macOS 27.0+
   documentation: `NSTextViewportLayoutControllerDelegate` method that the framework calls to request the current viewport, which is the view visible bounds plus the overdraw area. Requires a call to super.

12. [a:swift:Foundation::14729:Foundation.memoryDataMoved]
   framework: Foundation   (top level)
   name: memoryDataMoved   kind: var
   declaration: var public static var memoryDataMoved: Foundation.MachError.Foundation.Code { ; macOS 10.10+
   documentation: (none)

13. [a:objc:IOKit:IOCDTypes.h:172:CDConvertTrackNumberToMSF]
   framework: IOKit   (top level)
   name: CDConvertTrackNumberToMSF   kind: function
   declaration: function static inline CDMSF CDConvertTrackNumberToMSF(UInt8 track, CDTOC * toc) {
   documentation: Track Number To M:S:F Convenience Function The CDTOC structure is assumed to be complete, that is, none of the descriptors are missing or clipped due to an insufficiently sized buffer holding the CDTOC contents. /

14. [a:objc:FileProvider:NSFileProviderActions.h:106:NSFileProviderExtension.createDirectoryWithName:inParentItemIdentifier:completionHandler:]
   framework: FileProvider   member of: NSFileProviderExtension
   name: createDirectoryWithName:inParentItemIdentifier:completionHandler:   kind: method
   declaration: method - (void)createDirectoryWithName:(NSString *)directoryName inParentItemIdentifier:(NSFileProviderItemIdentifier)parentItemIdentifier completionHandler:(void (^)(NSFileProviderItem _Nullable createdDire
   documentation: Create a directory. This is expected to complete before doing any network. In the completion block, createdDirectoryItem should have these properties set: - itemIdentifier - parentItemIdentifier (to the value passed in to this method) - filename (to directoryName) - creationDate (to the current date and time) - contentType (to "public.folder" - UTT

15. [a:swift:SwiftUI::12942:ReorderDifference.Destination.collectionID]
   framework: SwiftUI   member of: ReorderDifference.Destination
   name: collectionID   kind: var
   declaration: var public var collectionID: CollectionID ; macOS 27.0+
   documentation: (none)

16. [a:objc:Matter:MTRBaseClusters.h:16279:MTRBaseClusterAudioControl.increaseVolumeWithParams:completion:]
   framework: Matter   member of: MTRBaseClusterAudioControl
   name: increaseVolumeWithParams:completion:   kind: method
   declaration: method - (void)increaseVolumeWithParams:(MTRAudioControlClusterIncreaseVolumeParams * _Nullable)params completion:(MTRStatusCompletion)completion MTR_PROVISIONALLY_AVAILABLE;
   documentation: Command IncreaseVolume Increases the volume by a specified level. /

17. [a:swift:MetricKit::872:HangTimeMetric]
   framework: MetricKit   (top level)
   name: HangTimeMetric   kind: struct
   declaration: struct public struct HangTimeMetric : Swift.Sendable, Swift.Codable, Swift.Hashable { ; macOS 27.0+
   documentation: (none)

18. [a:swift:AppKit::2761:AppKit.DidChangeBackingPropertiesMessage.oldColorSpace]
   framework: AppKit   member of: DidChangeBackingPropertiesMessage
   name: oldColorSpace   kind: var
   declaration: var public var oldColorSpace: AppKit.NSColorSpace? ; macOS 27.0+
   documentation: (none)

19. [a:objc:Foundation:NSURLHandle.h:140:NSURLHandle.cancelLoadInBackground]
   framework: Foundation   member of: NSURLHandle
   name: cancelLoadInBackground   kind: method
   declaration: method - (void)cancelLoadInBackground API_DEPRECATED("", macos(10.0, 10.4)) API_UNAVAILABLE(ios, watchos, tvos); ; macOS 10.0+, deprecated macOS 10.4
   documentation: Called to cancel a load currently in progress. This method is provided mainly for subclasses that wish to take some action before a background load is canceled. This method should invoke `super`'s implementation before returning.

20. [a:swift:Foundation::12075:Foundation.Properties.EstimatedTimeRemaining]
   framework: Foundation   member of: Properties
   name: EstimatedTimeRemaining   kind: enum
   declaration: enum @frozen public enum EstimatedTimeRemaining : Swift.Sendable, Foundation.ProgressManager.Foundation.Property { ; macOS 27+
   documentation: (none)

21. [a:swift:AppKit::3244:AppKit.DidSendActionMessage]
   framework: AppKit   (top level)
   name: DidSendActionMessage   kind: struct
   declaration: struct public struct DidSendActionMessage { ; macOS 27.0+
   documentation: (none)

22. [a:swift:StoreKit::2462:StoreKit.AdvancedCommerceInfo.Partner]
   framework: StoreKit   member of: AdvancedCommerceInfo
   name: Partner   kind: struct
   declaration: struct public struct Partner : Swift.Equatable, Swift.Hashable, Swift.Sendable { ; macOS 27.0+
   documentation: (none)

23. [a:swift:Foundation::13041:URL.stopAccessingSecurityScopedResource]
   framework: Foundation   member of: URL
   name: stopAccessingSecurityScopedResource   kind: func
   declaration: func public func stopAccessingSecurityScopedResource() ; macOS 10.10+
   documentation: (none)

24. [a:objc:CoreImage:CIFilterBuiltins.h:1953:CIEdges.CIEdges]
   framework: CoreImage   member of: CIEdges
   name: CIEdges   kind: protocol
   declaration: protocol @protocol CIEdges <CIFilter>
   documentation: The protocol for the Edges filter. Finds all edges in an image and displays them in color.

25. [a:objc:QuickLook:QLGenerator.h:326:QLPreviewRequestSetDocumentObject]
   framework: QuickLook   (top level)
   name: QLPreviewRequestSetDocumentObject   kind: function
   declaration: function QL_EXPORT void QLPreviewRequestSetDocumentObject(QLPreviewRequestRef preview, const void* object, const CFArrayCallBacks* callbacks) API_DEPRECATED("Use a QLPreviewingController in a Preview Extension ; macOS 10.6+, deprecated macOS 12.0
   documentation: @function QLPreviewRequestSetDocumentObject Store some object in preview request. preview The preview request. object The object representing the document callbacks Callbacks to retain/release/etc. the object. You can only call this function once per request. /

26. [a:objc:IOUSBHost:AppleUSBDescriptorParsing.h:154:IOUSBGetSuperSpeedPlusDeviceCapabilityDescriptor]
   framework: IOUSBHost   (top level)
   name: IOUSBGetSuperSpeedPlusDeviceCapabilityDescriptor   kind: function
   declaration: function const IOUSBDeviceCapabilitySuperSpeedPlusUSB* IOUSBGetSuperSpeedPlusDeviceCapabilityDescriptor(const IOUSBBOSDescriptor* bosDescriptor);
   documentation: Find the first SuperSpeedPlusUSBDeviceCapabilityDescriptor in a BOS descriptor This method uses getNextCapabilityDescriptorWithType to fetch the first SuperSpeedPlusUSBDeviceCapabilityDescriptor bosDescriptor BOS descriptor that contains the descriptors to iterate through SuperSpeedPlusUSBDeviceCapabilityDescriptor pointer, or NULL if no matching d

27. [a:objc:JavaScriptCore:JSValueRef.h:328:JSValueMakeUndefined]
   framework: JavaScriptCore   (top level)
   name: JSValueMakeUndefined   kind: function
   declaration: function JS_EXPORT JSC_NULL_UNSPECIFIED JSValueRef JSValueMakeUndefined(JSC_NULL_UNSPECIFIED JSContextRef ctx);
   documentation: @function Creates a JavaScript value of the undefined type. ctx The execution context to use. The unique undefined value.

28. [a:objc:WebKit:WKScriptMessageHandlerWithReply.h:91:WKScriptMessageHandlerWithReply.userContentController:didReceiveScriptMessage:replyHandler:]
   framework: WebKit   member of: WKScriptMessageHandlerWithReply
   name: userContentController:didReceiveScriptMessage:replyHandler:   kind: method
   declaration: method - (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message replyHandler:(WK_SWIFT_UI_ACTOR void (^)(id _Nullable reply, NSString  ; macOS 11.0+
   documentation: Invoked when a script message is received from a webpage. userContentController The user content controller invoking the delegate method. message The script message received. replyHandler A block to be called with the result of processing the message. When the JavaScript running in your application's web content called window.webkit.messageHandlers

29. [a:swift:RealityFoundation::16171:BehaviorTreeAction]
   framework: RealityFoundation   (top level)
   name: BehaviorTreeAction   kind: protocol
   declaration: protocol public protocol BehaviorTreeAction : RealityFoundation.EntityAction { ; macOS 27.0+
   documentation: (none)

30. [a:swift:RealityFoundation::3378:RealityFoundation.sessionID]
   framework: RealityFoundation   (top level)
   name: sessionID   kind: var
   declaration: var public var sessionID: Foundation.UUID? { ; macOS 15.0+
   documentation: (none)

31. [a:swift:AppKit::2437:Foundation.contextHelpModeDidActivate]
   framework: AppKit   member of: Foundation
   name: contextHelpModeDidActivate   kind: var
   declaration: var @_alwaysEmitIntoClient public static var contextHelpModeDidActivate: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSHelpManager.AppKit.ContextHelpModeDidActivateMessage> { ; macOS 27.0+
   documentation: (none)

32. [a:swift:MetricKit::115:HangDiagnostic]
   framework: MetricKit   (top level)
   name: HangDiagnostic   kind: struct
   declaration: struct public struct HangDiagnostic : Swift.Sendable, Swift.Codable { ; macOS 27.0+
   documentation: (none)

33. [a:swift:USDKit::2073:USDKit.VariantSet.blockSelection]
   framework: USDKit   member of: VariantSet
   name: blockSelection   kind: func
   declaration: func public func blockSelection() throws ; macOS 27.0+
   documentation: (none)

34. [a:swift:USDKit::1503:USDKit.ValueType.float4]
   framework: USDKit   member of: ValueType
   name: float4   kind: var
   declaration: var public static var float4: USDKit.USDPrim.USDKit.Attribute.USDKit.ValueType { ; macOS 27.0+
   documentation: (none)

35. [a:swift:CreateML::3641:CreateML.FeatureExtractionParameters]
   framework: CreateML   (top level)
   name: FeatureExtractionParameters   kind: struct
   declaration: struct public struct FeatureExtractionParameters : Swift.Sendable { ; macOS 11.0+
   documentation: (none)

36. [a:swift:USDKit::1569:USDKit.ValueType.textureCoordinate2d]
   framework: USDKit   member of: ValueType
   name: textureCoordinate2d   kind: var
   declaration: var public static var textureCoordinate2d: USDKit.USDPrim.USDKit.Attribute.USDKit.ValueType { ; macOS 27.0+
   documentation: (none)

37. [a:swift:RealityFoundation::1543:SceneUnderstandingComponent.EntityType]
   framework: RealityFoundation   member of: SceneUnderstandingComponent
   name: EntityType   kind: enum
   declaration: enum public enum EntityType : Swift.Hashable { ; macOS 27.0+
   documentation: (none)

38. [a:swift:SwiftUICore::11541:SwiftUICore.Resolved.isItalic]
   framework: SwiftUICore   member of: Resolved
   name: isItalic   kind: var
   declaration: var public var isItalic: Swift.Bool { ; macOS 26.0+
   documentation: (none)

39. [a:objc:SceneKit:SceneKitDeprecated.h:46:SCNLight.attributeForKey:]
   framework: SceneKit   member of: SCNLight
   name: attributeForKey:   kind: method
   declaration: method - (nullable id)attributeForKey:(NSString *)key API_DEPRECATED("Use SCNLight properties instead", macos(10.8, 10.10)) API_UNAVAILABLE(ios, tvos, watchos, macCatalyst, visionos); ; macOS 10.8+, deprecated macOS 10.10
   documentation: @method attributeForKey: key The key for which to return the corresponding attribute. Returns the attribute for the specified key. The valid keys are described in the "Light Attributes" constants. /

40. [a:objc:vecLib:bnns_graph.h:592:BNNSGraphContextDestroy]
   framework: vecLib   (top level)
   name: BNNSGraphContextDestroy   kind: function
   declaration: function void BNNSGraphContextDestroy(bnns_graph_context_t context) __asm__("_BNNSGraphContextDestroy_v2") __API_AVAILABLE(macos(15.0), ios(18.0), watchos(11.0), tvos(18.0)); ; macOS 15.0+
   documentation: Destroys a graph context created through a call to `BNNSGraphContextMake` or `BNNSGraphContextMakeStreaming` Arguments: `context`: object to be destroyed

41. [a:objc:Metal:MTLPixelFormat.h:74:MTLPixelFormat.MTLPixelFormatRGB8Uint]
   framework: Metal   member of: MTLPixelFormat
   name: MTLPixelFormatRGB8Uint   kind: enumCase
   declaration: enumCase MTLPixelFormatRGB8Uint API_AVAILABLE(macos(27.0), ios(27.0)) = 47, ; macOS 27.0+
   documentation: * The ``MTLTextureDescriptor/textureType`` property needs to be equal to ``MTLTextureType/MTLTextureTypeTextureBuffer``.

42. [a:swift:Foundation::12056:Foundation.Properties.Throughput]
   framework: Foundation   member of: Properties
   name: Throughput   kind: enum
   declaration: enum @frozen public enum Throughput : Swift.Sendable, Foundation.ProgressManager.Foundation.Property { ; macOS 27+
   documentation: (none)

43. [a:swift:AccessoryAccess::28:AccessoryAccess.DeviceMatchingCriteria.deviceSubClass]
   framework: AccessoryAccess   member of: DeviceMatchingCriteria
   name: deviceSubClass   kind: var
   declaration: var public var deviceSubClass: Swift.Int? ; macOS 27.0+
   documentation: (none)

44. [a:swift:MetricKit::542:OptimizedTimeToFirstDrawMetric]
   framework: MetricKit   (top level)
   name: OptimizedTimeToFirstDrawMetric   kind: struct
   declaration: struct public struct OptimizedTimeToFirstDrawMetric : Swift.Sendable, Swift.Codable, Swift.Hashable { ; macOS 27.0+
   documentation: (none)

45. [a:objc:Speech:SFSpeechRecognitionTaskHint.h:24:SFSpeechRecognitionTaskHint.SFSpeechRecognitionTaskHintSearch]
   framework: Speech   member of: SFSpeechRecognitionTaskHint
   name: SFSpeechRecognitionTaskHintSearch   kind: enumCase
   declaration: enumCase SFSpeechRecognitionTaskHintSearch = 2, ; macOS 10.15+
   documentation: Use this hint type when you are using speech recognition to identify search terms.

46. [a:objc:CoreMedia:CMTimeRange.h:364:CMTimeMappingMake]
   framework: CoreMedia   (top level)
   name: CMTimeMappingMake   kind: function
   declaration: function CM_EXPORT CMTimeMapping CMTimeMappingMake( CMTimeRange source, /*! @param source Initializes the source field of the resulting CMTimeMapping. */ CMTimeRange target) /*! @param target Initializes the t ; macOS 10.11+
   documentation: @function CMTimeMappingMake Make a valid CMTimeMapping with source and target. The resulting CMTimeMapping. The source and target parameters must have durations whose epoch is 0; otherwise an invalid time mapping will be returned.
