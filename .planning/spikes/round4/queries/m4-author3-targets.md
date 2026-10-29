# M4 targets for author 3

1. [a:objc:MetalFX:MTLFXTemporalScaler.h:247:MTLFXTemporalScalerBase.depthContentOffsetY]
   framework: MetalFX   member of: MTLFXTemporalScalerBase
   name: depthContentOffsetY   kind: property
   declaration: property @property (nonatomic) NSUInteger depthContentOffsetY API_AVAILABLE(macos(27.0), ios(27.0)) API_UNAVAILABLE(visionos); ; macOS 27.0+
   documentation: The vertical offset, in pixels, of the region within the depth texture to use as input.

2. [a:objc:AudioVideoBridging:AVBConstants.h:556:AVB17221ACMPStatusCode.AVB17221ACMPStatusUnableToSendMessage]
   framework: AudioVideoBridging   member of: AVB17221ACMPStatusCode
   name: AVB17221ACMPStatusUnableToSendMessage   kind: enumCase
   declaration: enumCase AVB17221ACMPStatusUnableToSendMessage = 0x0c, ; macOS 12+
   documentation: AVB17221ACMPStatusUnableToSendMessage The IEEE Std 1722.1™-2013 ACMP COULD_NOT_SEND_MESSAGE status code. /

3. [a:swift:AppKit::3283:AppKit.DidBeginTrackingMessage]
   framework: AppKit   (top level)
   name: DidBeginTrackingMessage   kind: struct
   declaration: struct public struct DidBeginTrackingMessage { ; macOS 27.0+
   documentation: (none)

4. [a:objc:vecLib:bnns.h:1733:BNNSDirectApplyActivationBatch]
   framework: vecLib   (top level)
   name: BNNSDirectApplyActivationBatch   kind: function
   declaration: function int BNNSDirectApplyActivationBatch(const BNNSLayerParametersActivation * layer_params, const BNNSFilterParameters * _Nullable filter_params, size_t batch_size, size_t in_stride, size_t out_stride) __A ; macOS 11.0+, deprecated macOS 15.0
   documentation: Direct Apply an Activation/Conversion filter to several pairs of (input, output) data equal to calling BNNSCreateActivation & BNNSFilterApplyBatch & BNNSDestroy layer_params Layer parameters and input, weights, output, bias and activation descriptors should set i_desc.data pointing to input data and o_desc.data pointing to output data filter_params

5. [a:objc:Security:SecKeychain.h:204:SecKeychainEvent]
   framework: Security   (top level)
   name: SecKeychainEvent   kind: enum
   declaration: enum typedef CF_ENUM(UInt32, SecKeychainEvent) { kSecLockEvent = 1, kSecUnlockEvent = 2, kSecAddEvent = 3, kSecDeleteEvent = 4, kSecUpdateEvent = 5, kSecPasswordChangedEvent = 6, kSecDefaultChangedEvent =  ; macOS 10.10+, deprecated macOS 10.15
   documentation: @enum KeychainEventConstants Defines the keychain-related event. kSecLockEvent Indicates a keychain was locked. kSecUnlockEvent Indicates a keychain was unlocked. kSecAddEvent Indicates an item was added to a keychain. kSecDeleteEvent Indicates an item was deleted from a keychain. kSecUpdateEvent Indicates a keychain item was updated. kSecPasswordC

6. [a:objc:OpenDirectory:ODRecord.h:57:ODRecord.setNodeCredentialsWithRecordType:authenticationType:authenticationItems:continueItems:context:error:]
   framework: OpenDirectory   member of: ODRecord
   name: setNodeCredentialsWithRecordType:authenticationType:authenticationItems:continueItems:context:error:   kind: method
   declaration: method - (BOOL)setNodeCredentialsWithRecordType:(ODRecordType)inRecordType authenticationType:(ODAuthenticationType)inType authenticationItems:(NSArray *)inItems continueItems:(NSArray **)outItems context:(i ; 
   documentation: @method setNodeCredentialsWithRecordType:authenticationType:authenticationItems:continueItems:context:error: Similar to calling -[ODNode setCredentialsWithRecordType:] except credentials are only set for this particular record's node Allows the caller to use other types of authentications that are available in OpenDirectory, that may require respon

7. [a:swift:CoreSpotlight::19:SearchableItemAttribute]
   framework: CoreSpotlight   (top level)
   name: SearchableItemAttribute   kind: struct
   declaration: struct public struct SearchableItemAttribute : Swift.Hashable, Swift.Sendable, Swift.RawRepresentable { ; macOS 27.0+
   documentation: (none)

8. [a:swift:AppKit::2738:AppKit.WillBeginSheetMessage]
   framework: AppKit   (top level)
   name: WillBeginSheetMessage   kind: struct
   declaration: struct public struct WillBeginSheetMessage { ; macOS 27.0+
   documentation: (none)

9. [a:swift:USDKit::2136:USDStage.OpenOptions]
   framework: USDKit   member of: USDStage
   name: OpenOptions   kind: struct
   declaration: struct public struct OpenOptions : Swift.Sendable, Swift.ExpressibleByArrayLiteral { ; macOS 27.0+
   documentation: (none)

10. [a:objc:Foundation:NSArray.h:1243:NSMutableArray.sortUsingFunction:context:]
   framework: Foundation   member of: NSMutableArray
   name: sortUsingFunction:context:   kind: method
   declaration: method - (void)sortUsingFunction:(NSInteger (NS_NOESCAPE *)(ObjectType, ObjectType, void * _Nullable))compare context:(nullable void *)context;
   documentation: Sorts the receiver in ascending order as defined by the comparison function `compare`. This approach allows the comparison to be based on some outside parameter, such as whether character sorting is case sensitive or case insensitive. - Parameters: - compare: The comparison function to use to compare two elements at a time. The function's parameter

11. [a:swift:RealityFoundation::4208:RealityFoundation.Plane]
   framework: RealityFoundation   (top level)
   name: Plane   kind: struct
   declaration: struct public struct Plane : Swift.Equatable { ; macOS 15.0+
   documentation: (none)

12. [a:objc:MetalFX:MTLFXTemporalScaler.h:255:MTLFXTemporalScalerBase.reactiveMaskContentOffsetX]
   framework: MetalFX   member of: MTLFXTemporalScalerBase
   name: reactiveMaskContentOffsetX   kind: property
   declaration: property @property (nonatomic) NSUInteger reactiveMaskContentOffsetX API_AVAILABLE(macos(27.0), ios(27.0)) API_UNAVAILABLE(visionos); ; macOS 27.0+
   documentation: The horizontal offset, in pixels, of the region within the reactive mask texture to use as input.

13. [a:swift:NetworkExtension::125:NEURLFilterManager.ReportFormat]
   framework: NetworkExtension   member of: NEURLFilterManager
   name: ReportFormat   kind: enum
   declaration: enum public enum ReportFormat : Swift.Sendable { ; macOS 27.0+
   documentation: (none)

14. [a:swift:AppKit::3328:Foundation.didChangeItem]
   framework: AppKit   member of: Foundation
   name: didChangeItem   kind: var
   declaration: var @_alwaysEmitIntoClient public static var didChangeItem: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSMenu.AppKit.DidChangeItemMessage> { ; macOS 27.0+
   documentation: (none)

15. [a:objc:CoreMedia:CMGenlockClock.h:32:CMClockCreateGenlockClock]
   framework: CoreMedia   (top level)
   name: CMClockCreateGenlockClock   kind: function
   declaration: function CM_EXPORT CM_NULLABLE CM_RETURNS_RETAINED CMClockRef CMClockCreateGenlockClock(void) CM_REFINED_FOR_SWIFT API_AVAILABLE(macos(27.0), macCatalyst(27.0)) API_UNAVAILABLE(ios, tvos, watchos, visionos); ; macOS 27.0+
   documentation: Returns a clock whose time is based on genlock when the system is synchronized to an external genlock signal, and on host time otherwise. When the system is not synchronized to an external genlock signal, the returned clock will provide a time based on the host time clock. When the system is synchronized to an external genlock signal, the returned 

16. [a:objc:Metal:MTLTensor.h:24:MTLTensorDataType.MTLTensorDataTypeFloat32]
   framework: Metal   member of: MTLTensorDataType
   name: MTLTensorDataTypeFloat32   kind: enumCase
   declaration: enumCase MTLTensorDataTypeFloat32 = MTLDataTypeFloat, ; macOS 27.0+
   documentation: A single-precision floating point data type.

17. [a:objc:MetalKit:MTKModel.h:284:MTKMetalVertexDescriptorFromModelIOWithError]
   framework: MetalKit   (top level)
   name: MTKMetalVertexDescriptorFromModelIOWithError   kind: function
   declaration: function MTK_EXTERN MTLVertexDescriptor* __nullable MTKMetalVertexDescriptorFromModelIOWithError(MDLVertexDescriptor* __nonnull modelIODescriptor, NSError * __nullable * __nullable error) NS_AVAILABLE(10_12, 1 ; 
   documentation: @function MTKMetalVertexDescriptorFromModelIOWithError Partially converts a Model I/O vertex descriptor to a Metal vertex descriptor This method can only set vertex format, offset, bufferIndex, and stride information in the produced Metal vertex descriptor. It simply copies attributes 1 for 1. Thus attributes in the given Model I/O vertex descripto

18. [a:swift:AppKit::2867:Foundation.didBecomeKey]
   framework: AppKit   member of: Foundation
   name: didBecomeKey   kind: var
   declaration: var @_alwaysEmitIntoClient public static var didBecomeKey: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSWindow.AppKit.DidBecomeKeyMessage> { ; macOS 27.0+
   documentation: (none)

19. [a:objc:Hypervisor:hv_vmx.h:221:hv_vmx_get_msr_info]
   framework: Hypervisor   (top level)
   name: hv_vmx_get_msr_info   kind: function
   declaration: function extern hv_return_t hv_vmx_get_msr_info(hv_vmx_msr_info_t field, uint64_t *value) __HV_11_0;
   documentation: @function hv_vmx_get_msr_info Returns information about guest MSR configuration field ID of the MSR to be examined value Pointer to the info field value (written on success) 0 on success or error code See Documentation for info that can be requested. /

20. [a:swift:CloudKit::929:CKRecordValueProtocol]
   framework: CloudKit   (top level)
   name: CKRecordValueProtocol   kind: protocol
   declaration: protocol public protocol CKRecordValueProtocol { ; macOS 10.10+
   documentation: (none)

21. [a:objc:AppKit:NSTouchBar.h:187:NSResponder.makeTouchBar]
   framework: AppKit   member of: NSResponder
   name: makeTouchBar   kind: method
   declaration: method - (nullable NSTouchBar *)makeTouchBar API_AVAILABLE(macos(10.12.2)); ; macOS 10.12.2+
   documentation: Subclasses should over-ride this method to create and configure the default NSTouchBar for this responder.

22. [a:swift:FoundationModels::642:AnyDynamicInstructions]
   framework: FoundationModels   (top level)
   name: AnyDynamicInstructions   kind: struct
   declaration: struct public struct AnyDynamicInstructions : FoundationModels.DynamicInstructions { ; macOS 27.0+
   documentation: (none)

23. [a:swift:CoreVideo::85:CVAttachmentCompositeKeyDefinition]
   framework: CoreVideo   (top level)
   name: CVAttachmentCompositeKeyDefinition   kind: struct
   declaration: struct public struct CVAttachmentCompositeKeyDefinition<ModePreference, Value> : Swift.Hashable, Swift.Sendable, Swift.ExpressibleByArrayLiteral where ModePreference : CoreVideo.CVAttachmentModePreference, V ; macOS 27.0+
   documentation: (none)

24. [a:swift:WidgetKit::230:SwiftUICore.widgetFamily]
   framework: WidgetKit   member of: SwiftUICore
   name: widgetFamily   kind: var
   declaration: var public var widgetFamily: WidgetKit.WidgetFamily { ; macOS 11.0+
   documentation: (none)

25. [a:objc:Foundation:NSURLSession.h:583:NSURLSession.uploadTaskWithRequest:fromFile:completionHandler:]
   framework: Foundation   member of: NSURLSession
   name: uploadTaskWithRequest:fromFile:completionHandler:   kind: method
   declaration: method - (NSURLSessionUploadTask *)uploadTaskWithRequest:(NSURLRequest *)request fromFile:(NSURL *)fileURL completionHandler:(void (NS_SWIFT_SENDABLE ^)(NSData * _Nullable data, NSURLResponse * _Nullable res
   documentation: Creates a task that performs an HTTP request for uploading the specified file, then calls a handler upon completion. - Parameter request: A URL request object that provides the URL, cache policy, request type, and so on. The body stream and body data in this request object are ignored. - Parameter fileURL: The URL of the file to upload. - Parameter

26. [a:objc:DiscRecording:DRFSObject.h:518:DRFSObject.isVirtual]
   framework: DiscRecording   member of: DRFSObject
   name: isVirtual   kind: method
   declaration: method - (BOOL) isVirtual;
   documentation: @method isVirtual Indicates whether the receiver is real or virtual. <i>YES</i> if the receiver is virtual and <i>NO</i> if real.

27. [a:objc:LatentSemanticMapping:LatentSemanticMapping.h:223:LSMMapAddTextWithWeight]
   framework: LatentSemanticMapping   (top level)
   name: LSMMapAddTextWithWeight   kind: function
   declaration: function OSStatus LSMMapAddTextWithWeight(LSMMapRef mapref, LSMTextRef textref, LSMCategory category, float weight);
   documentation: @function LSMMapAddTextWithWeight Adds a training text to the given category with a weight different from 1. The weight may be negative, but global counts will be pinned to 0. The textref is no longer needed after this call. /

28. [a:swift:AppKit::1401:Foundation.willFinishLaunching]
   framework: AppKit   member of: Foundation
   name: willFinishLaunching   kind: var
   declaration: var @_alwaysEmitIntoClient public static var willFinishLaunching: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSApplication.AppKit.WillFinishLaunchingMessage> { ; macOS 27.0+
   documentation: (none)

29. [a:swift:CoreGraphics::265:log10]
   framework: CoreGraphics   (top level)
   name: log10   kind: func
   declaration: func @_transparent public func log10(_ x: CoreFoundation.CGFloat) -> CoreFoundation.CGFloat { ; macOS 10.9+
   documentation: (none)

30. [a:objc:Foundation:NSProxy.h:20:NSProxy.alloc]
   framework: Foundation   member of: NSProxy
   name: alloc   kind: classMethod
   declaration: classMethod + (id)alloc;
   documentation: Returns a new, uninitialized instance of the receiving class.

31. [a:swift:MusicKit::877:LibraryAlbumSortProperties]
   framework: MusicKit   (top level)
   name: LibraryAlbumSortProperties   kind: protocol
   declaration: protocol public protocol LibraryAlbumSortProperties { ; macOS 14.0+
   documentation: (none)

32. [a:swift:USDKit::4884:USDKit.ExportOptions.TextureQuality]
   framework: USDKit   member of: ExportOptions
   name: TextureQuality   kind: struct
   declaration: struct public struct TextureQuality : Swift.Hashable, Swift.Sendable { ; macOS 27.0+
   documentation: (none)

33. [a:objc:AppKit:NSSharingService.h:153:NSSharingContentScope.NSSharingContentScopePartial]
   framework: AppKit   member of: NSSharingContentScope
   name: NSSharingContentScopePartial   kind: enumCase
   declaration: enumCase NSSharingContentScopePartial, ; macOS 15.0+
   documentation: NSSharingContentScopePartial: use when sharing a portion of a more global content, e.g. part of a webpage

34. [a:objc:GameController:GCControllerHomeButtonSettingsManager.h:75:GCControllerHomeButtonSettingSystemAction.GCControllerHomeButtonSettingCustomizationDefault]
   framework: GameController   member of: GCControllerHomeButtonSettingSystemAction
   name: GCControllerHomeButtonSettingCustomizationDefault   kind: enumCase
   declaration: enumCase GCControllerHomeButtonSettingCustomizationDefault NS_SWIFT_NAME(systemDefault) = 0, ; macOS 27.0+
   documentation: The user has not customized this setting. The setting's value is the system default.

35. [a:objc:CoreFoundation:CFArray.h:108:CFArrayRef]
   framework: CoreFoundation   (top level)
   name: CFArrayRef   kind: typedef
   declaration: typedef typedef const struct CF_BRIDGED_TYPE(NSArray) __CFArray * CFArrayRef;
   documentation: @typedef CFArrayRef This is the type of a reference to immutable CFArrays.

36. [a:objc:Metal:MTLTensor.h:153:MTLTensorDataType.MTLTensorPlaneTypeData]
   framework: Metal   member of: MTLTensorDataType
   name: MTLTensorPlaneTypeData   kind: enumCase
   declaration: enumCase MTLTensorPlaneTypeData = 0, ; macOS 27.0+
   documentation: The main data plane, which every tensor has
