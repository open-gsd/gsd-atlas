# M5 targets for author 3

Task context for every query below: You are porting or migrating code from another platform or from an older API and need the matching declaration in this SDK.

1. [a:objc:Hypervisor:hv_gic.h:214:hv_gic_get_icv_reg]
   framework: Hypervisor   (top level)
   name: hv_gic_get_icv_reg   kind: function
   declaration: function OS_EXPORT API_AVAILABLE(macos(15.0)) hv_return_t hv_gic_get_icv_reg(hv_vcpu_t vcpu, hv_gic_icv_reg_t reg, uint64_t* value); ; macOS 15.0+
   documentation: Read a GIC ICV system register. vcpu Handle for the vcpu. reg GIC ICV system register enum. value Pointer to ICV register value (written on success). HV_SUCCESS on success, an error code otherwise. ICV registers are only available when EL2 is enabled, otherwise returns an error. Must be called by the owning thread. /

2. [a:objc:CoreMedia:CMSampleBuffer.h:1314:CMSampleBufferGetOutputDecodeTimeStamp]
   framework: CoreMedia   (top level)
   name: CMSampleBufferGetOutputDecodeTimeStamp   kind: function
   declaration: function CM_EXPORT CMTime CMSampleBufferGetOutputDecodeTimeStamp( CMSampleBufferRef CM_NONNULL sbuf) /*! @param sbuf CMSampleBuffer being interrogated */ API_AVAILABLE(macos(10.7), ios(4.0), tvos(9.0), watchos ; macOS 10.7+
   documentation: @function CMSampleBufferGetOutputDecodeTimeStamp Returns the output decode timestamp of the CMSampleBuffer. For consistency with CMSampleBufferGetOutputPresentationTimeStamp, this is calculated as: OutputPresentationTimeStamp + ((DecodeTimeStamp - PresentationTimeStamp) / SpeedMultiplier). CMInvalidTime is returned if there is an error.

3. [a:swift:CompositorServices::58:CompositorServices.supportsFoveation]
   framework: CompositorServices   (top level)
   name: supportsFoveation   kind: var
   declaration: var public var supportsFoveation: Swift.Bool { ; macOS 26.0+
   documentation: (none)

4. [a:objc:CoreImage:CIFilterBuiltins.h:422:CIDisintegrateWithMaskTransition.CIDisintegrateWithMaskTransition]
   framework: CoreImage   member of: CIDisintegrateWithMaskTransition
   name: CIDisintegrateWithMaskTransition   kind: protocol
   declaration: protocol @protocol CIDisintegrateWithMaskTransition <CITransitionFilter>
   documentation: The protocol for the Disintegrate With Mask filter. Transitions from one image to another using the shape defined by a mask.

5. [a:swift:AppKit::1413:Foundation.willResignActive]
   framework: AppKit   member of: Foundation
   name: willResignActive   kind: var
   declaration: var @_alwaysEmitIntoClient public static var willResignActive: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSApplication.AppKit.WillResignActiveMessage> { ; macOS 27.0+
   documentation: (none)

6. [a:objc:GameController:GCControllerHomeButtonSettingsManager.h:27:GCControllerHomeButtonSettingSystemAction.GCControllerHomeButtonSettingSystemActionOther]
   framework: GameController   member of: GCControllerHomeButtonSettingSystemAction
   name: GCControllerHomeButtonSettingSystemActionOther   kind: enumCase
   declaration: enumCase GCControllerHomeButtonSettingSystemActionOther = 0, ; macOS 27.0+
   documentation: The controller home button system action performs some other action.

7. [a:swift:NowPlaying::64:MediaCommand.togglePlayPause]
   framework: NowPlaying   member of: MediaCommand
   name: togglePlayPause   kind: func
   declaration: func public static func togglePlayPause(_ action: @escaping () async throws -> Swift.Void) -> NowPlaying.MediaCommand ; macOS 27+
   documentation: (none)

8. [a:objc:ImageIO:CGImageAnimation.h:100:CGAnimateImageDataWithBlock]
   framework: ImageIO   (top level)
   name: CGAnimateImageDataWithBlock   kind: function
   declaration: function IMAGEIO_EXTERN OSStatus CGAnimateImageDataWithBlock(CFDataRef data, CFDictionaryRef _iio_Nullable options, CGImageSourceAnimationBlock block) IMAGEIO_AVAILABLE_STARTING(10.15, 13.0);
   documentation: Animate the sequence of images using data from a Graphics Interchange Format (GIF) or Animated Portable Network Graphics (APNG) file file. - Parameters: - data: The image data to animate. - options: Additional playback options. Include the ``kCGImageAnimationDelayTime`` or ``kCGImageAnimationLoopCount`` keys to override the timing information in th

9. [a:objc:Foundation:NSXPCConnection.h:36:NSXPCProxyCreating.remoteObjectProxyWithErrorHandler:]
   framework: Foundation   member of: NSXPCProxyCreating
   name: remoteObjectProxyWithErrorHandler:   kind: method
   declaration: method - (id)remoteObjectProxyWithErrorHandler:(void (NS_SWIFT_SENDABLE ^)(NSError *error))handler;
   documentation: Returns a proxy object which will invoke the error handling block if an error occurs on the connection. If the message sent to the proxy has a reply handler, then either the error handler or the reply handler will be called exactly once. This proxy object will also conform with the `NSXPCProxyCreating` protocol.

10. [a:swift:AppIntents::4211:EntityQuery.displayRepresentations]
   framework: AppIntents   member of: EntityQuery
   name: displayRepresentations   kind: func
   declaration: func func displayRepresentations(for identifiers: [Self.Entity.ID]) async throws -> [Self.Entity.ID : AppIntents.DisplayRepresentation] ; macOS 27.0+
   documentation: (none)

11. [a:swift:AppKit::1256:AppKit.DidUnhideMessage]
   framework: AppKit   (top level)
   name: DidUnhideMessage   kind: struct
   declaration: struct public struct DidUnhideMessage { ; macOS 27.0+
   documentation: (none)

12. [a:swift:RealityFoundation::11613:__RKEntityAudioAction.spatialMode]
   framework: RealityFoundation   member of: __RKEntityAudioAction
   name: spatialMode   kind: var
   declaration: var public var spatialMode: RealityFoundation.__RKAudioSpatialModeSelection ; macOS 10.15+
   documentation: (none)

13. [a:objc:Metal:MTLPixelFormat.h:190:MTLPixelFormat.MTLPixelFormatRGB32Uint]
   framework: Metal   member of: MTLPixelFormat
   name: MTLPixelFormatRGB32Uint   kind: enumCase
   declaration: enumCase MTLPixelFormatRGB32Uint API_AVAILABLE(macos(27.0), ios(27.0)) = 120, ; macOS 27.0+
   documentation: * The ``MTLTextureDescriptor/textureType`` property needs to be equal to ``MTLTextureType/MTLTextureTypeTextureBuffer``.

14. [a:objc:ColorSync:ColorSyncCMM.h:83:ColorSyncIterateInstalledCMMs]
   framework: ColorSync   (top level)
   name: ColorSyncIterateInstalledCMMs   kind: function
   declaration: function CSEXTERN_DESKTOP void ColorSyncIterateInstalledCMMs (ColorSyncCMMIterateCallback callBack, void* __nullable userInfo) CS_AVAILABLE_DESKTOP(10.4);
   documentation: Iterates over the installed CMMs, invoking a callback for each one. - Parameters: - callBack: A pointer to a client-provided function. - userInfo: A pointer to the user info that the framework passes to the callback. Optional.

15. [a:swift:NowPlaying::525:MediaDuration]
   framework: NowPlaying   (top level)
   name: MediaDuration   kind: enum
   declaration: enum public enum MediaDuration { ; macOS 27+
   documentation: (none)

16. [a:objc:AppKit:NSWritingToolsCoordinator.h:151:NSWritingToolsCoordinatorTextUpdateReason.NSWritingToolsCoordinatorTextReplacementReasonAccepted]
   framework: AppKit   member of: NSWritingToolsCoordinatorTextUpdateReason
   name: NSWritingToolsCoordinatorTextReplacementReasonAccepted   kind: enumCase
   declaration: enumCase NSWritingToolsCoordinatorTextReplacementReasonAccepted API_AVAILABLE(macos(27.0)) = 2, // a replacement from grammar presentation, representing acceptance of a proposed suggestion ; macOS 27.0+
   documentation: used. Update your view's text storage without animating the change.

17. [a:objc:Foundation:NSString.h:1196:NSMutableString.setString:]
   framework: Foundation   member of: NSMutableString
   name: setString:   kind: method
   declaration: method - (void)setString:(NSString *)aString;
   documentation: Replaces the characters of the receiver with those in a given string. aString The string with which to replace the receiver's content. @c aString must not be @c nil.

18. [a:objc:AudioToolbox:AudioQueue.h:1208:AudioQueueEnqueueBufferWithParameters]
   framework: AudioToolbox   (top level)
   name: AudioQueueEnqueueBufferWithParameters   kind: function
   declaration: function extern OSStatus AudioQueueEnqueueBufferWithParameters( AudioQueueRef inAQ, AudioQueueBufferRef inBuffer, UInt32 inNumPacketDescs, const AudioStreamPacketDescription * __nullable inPacketDescs, UInt32  ; macOS 10.5+
   documentation: @function AudioQueueEnqueueBufferWithParameters Assigns a buffer to an audio queue for playback, providing parameters and start time information. You can exert some control of the buffer queue by using this function. You can assign audio queue settings that are in effect carried by an audio queue buffer as you enqueue it. Hence, these changes only 

19. [a:swift:PaperKit::482:LinkMarkup]
   framework: PaperKit   (top level)
   name: LinkMarkup   kind: struct
   declaration: struct public struct LinkMarkup : PaperKit.Markup, Swift.Identifiable { ; macOS 27.0+
   documentation: (none)

20. [a:swift:BackgroundAssets::327:AssetPackManifest.assetPack]
   framework: BackgroundAssets   member of: AssetPackManifest
   name: assetPack   kind: func
   declaration: func public func assetPack(withID id: Swift.String) -> BackgroundAssets.AssetPack? ; macOS 27+
   documentation: (none)

21. [a:swift:TabularData::216:AnyColumnPrototype]
   framework: TabularData   (top level)
   name: AnyColumnPrototype   kind: protocol
   declaration: protocol public protocol AnyColumnPrototype { ; macOS 12+
   documentation: (none)

22. [a:swift:FoundationModels::249:FoundationModels.LimitIncreaseSuggestion]
   framework: FoundationModels   (top level)
   name: LimitIncreaseSuggestion   kind: struct
   declaration: struct public struct LimitIncreaseSuggestion : Swift.Sendable { ; macOS 27.0+
   documentation: (none)

23. [a:objc:Foundation:NSDecimalNumber.h:107:NSDecimalNumber.initWithString:locale:]
   framework: Foundation   member of: NSDecimalNumber
   name: initWithString:locale:   kind: method
   declaration: method - (instancetype)initWithString:(nullable NSString *)numberValue locale:(nullable id)locale;
   documentation: Initializes a decimal number so that its value is equivalent to that in a given numeric string, interpreted using a given locale. - Parameters: - numberValue: A numeric string. - locale: A dictionary that defines the locale (specifically the `decimalSeparator`) to use to interpret the number in `numberValue`. - Returns: An `NSDecimalNumber` object 

24. [a:swift:ExtensionFoundation::27:AppExtension.Implementing]
   framework: ExtensionFoundation   member of: AppExtension
   name: Implementing   kind: typealias
   declaration: typealias typealias Implementing = ExtensionFoundation.AppExtensionPoint.ExtensionFoundation.Capabilities ; macOS 26.2+
   documentation: (none)

25. [a:swift:Charts::2856:PlotDimensionScaleRange]
   framework: Charts   (top level)
   name: PlotDimensionScaleRange   kind: struct
   declaration: struct public struct PlotDimensionScaleRange : Charts.PositionScaleRange { ; macOS 13.0+
   documentation: (none)

26. [a:swift:GameController::482:GCInputButtonMenu]
   framework: GameController   (top level)
   name: GCInputButtonMenu   kind: var
   declaration: var @_alwaysEmitIntoClient public var GCInputButtonMenu: Swift.String { ; macOS 11.0+
   documentation: (none)

27. [a:objc:Foundation:NSDictionary.h:145:NSDictionary.initWithObjects:forKeys:count:]
   framework: Foundation   member of: NSDictionary
   name: initWithObjects:forKeys:count:   kind: method
   declaration: method - (instancetype)initWithObjects:(const ObjectType _Nonnull [_Nullable])objects forKeys:(const KeyType <NSCopying> _Nonnull [_Nullable])keys count:(NSUInteger)cnt NS_DESIGNATED_INITIALIZER;
   documentation: Initializes a newly allocated dictionary with the specified number of key-value pairs constructed from the provided C arrays of keys and objects. - Parameters: - objects: A C array of values for the new dictionary. - keys: A C array of keys for the new dictionary. Each key is copied (using ``NSCopying/copy(with:)``; keys must conform to the `NSCopy

28. [a:swift:ComputeGraph::645:ComputeGraph.PointerDefinition]
   framework: ComputeGraph   (top level)
   name: PointerDefinition   kind: struct
   declaration: struct public struct PointerDefinition : Swift.Sendable, Swift.Equatable { ; macOS 27.0+
   documentation: (none)

29. [a:swift:AppIntents::223:ShortcutTileColor]
   framework: AppIntents   (top level)
   name: ShortcutTileColor   kind: enum
   declaration: enum public enum ShortcutTileColor { ; macOS 13.0+
   documentation: (none)

30. [a:objc:AppKit:NSWritingToolsCoordinator.h:143:NSWritingToolsCoordinatorTextUpdateReason.NSWritingToolsCoordinatorTextReplacementReasonNoninteractive]
   framework: AppKit   member of: NSWritingToolsCoordinatorTextUpdateReason
   name: NSWritingToolsCoordinatorTextReplacementReasonNoninteractive   kind: enumCase
   declaration: enumCase NSWritingToolsCoordinatorTextReplacementReasonNoninteractive, // an unanimated replacement prompted from writing tools, perhaps copied from the overlay-panel experience, perhaps a reverted rewrite or  ; macOS 27.0+
   documentation: method, update your view’s text storage without animating the change.

31. [a:objc:Photos:PhotosTypes.h:49:PHCollectionListSubtype.PHCollectionListSubtypeRootFolder]
   framework: Photos   member of: PHCollectionListSubtype
   name: PHCollectionListSubtypeRootFolder   kind: enumCase
   declaration: enumCase PHCollectionListSubtypeRootFolder API_AVAILABLE(macos(27), ios(27), tvos(27), visionos(27)) = 101, ; macOS 27+
   documentation: There is always one root folder in the library and does not allow ``/Photos/PHCollectionEditOperation/PHCollectionEditOperationRename`` or ``/Photos/PHCollectionEditOperation/PHCollectionEditOperationDelete``

32. [a:objc:vecLib:vBasicOps.h:717:vU128SubS]
   framework: vecLib   (top level)
   name: vU128SubS   kind: function
   declaration: function extern vUInt32 vU128SubS( vUInt32 vA, vUInt32 vB) API_AVAILABLE(macos(10.0)) API_UNAVAILABLE(ios, watchos, tvos); ; macOS 10.0+
   documentation: vU128SubS() Availability: Mac OS X: in version 10.0 and later in vecLib.framework CarbonLib: not in Carbon, but vecLib is compatible with CarbonLib Non-Carbon CFM: in vecLib 1.0 and later /

33. [a:swift:ComputeGraph::691:AdvanceParams.worldToLocal]
   framework: ComputeGraph   member of: AdvanceParams
   name: worldToLocal   kind: var
   declaration: var public var worldToLocal: simd.simd_float4x4 ; macOS 27.0+
   documentation: (none)

34. [a:objc:ARKit:object_tracking.h:952:ar_object_tracking_provider_is_supported]
   framework: ARKit   (top level)
   name: ar_object_tracking_provider_is_supported   kind: function
   declaration: function API_AVAILABLE(visionos(2.0)) AR_EXTERN bool ar_object_tracking_provider_is_supported(void) AR_REFINED_FOR_SWIFT; ; 
   documentation: Determine whether this device supports the object tracking provider. - Returns: `true` if the object tracking provider is supported on this device, `false` otherwise.

35. [a:objc:Foundation:NSLocale.h:82:NSLocale.displayNameForKey:value:]
   framework: Foundation   member of: NSLocale
   name: displayNameForKey:value:   kind: method
   declaration: method - (nullable NSString *)displayNameForKey:(NSLocaleKey)key value:(id)value;
   documentation: Returns the display name for the given locale component value.

36. [a:objc:AppKit:NSTextView.h:500:NSTextView.registerTextAttachmentViewProviderReusePolicy:forTextAttachmentViewProviderType:]
   framework: AppKit   member of: NSTextView
   name: registerTextAttachmentViewProviderReusePolicy:forTextAttachmentViewProviderType:   kind: method
   declaration: method - (void)registerTextAttachmentViewProviderReusePolicy:(NSTextAttachmentViewProviderReusePolicy)policy forTextAttachmentViewProviderType:(Class)viewProviderType API_AVAILABLE(macos(27.0)); ; macOS 27.0+
   documentation: Register the NSTextAttachmentViewProviderReusePolicy for all instances of a particular subclass of NSTextAttachmentViewProvider.

37. [a:objc:CoreImage:CIFilterBuiltins.h:1727:CIRoundedQRCodeGenerator.roundedData]
   framework: CoreImage   member of: CIRoundedQRCodeGenerator
   name: roundedData   kind: property
   declaration: property @property (nonatomic) bool roundedData;
   documentation: If true then the data points in the QRCode should have a rounded appearance.

38. [a:objc:SpriteKit:SKAction.h:229:SKAction.setTexture:]
   framework: SpriteKit   member of: SKAction
   name: setTexture:   kind: classMethod
   declaration: classMethod + (SKAction *)setTexture:(SKTexture *)texture API_AVAILABLE(ios(7.1), tvos(7.1), watchos(1.0), macos(10.10)); ; macOS 10.10+
   documentation: Creates an action that changes a sprite’s texture texture The new texture to use on the sprite /

39. [a:swift:ComputeGraph::239:ComputeGraph.Pipelines]
   framework: ComputeGraph   (top level)
   name: Pipelines   kind: struct
   declaration: struct public struct Pipelines : Swift.Sendable { ; macOS 27.0+
   documentation: (none)

40. [a:objc:CoreMIDI:MIDISetup.h:143:MIDISetupGetCurrent]
   framework: CoreMIDI   (top level)
   name: MIDISetupGetCurrent   kind: function
   declaration: function extern OSStatus MIDISetupGetCurrent( MIDISetupRef *outSetup ) API_DEPRECATED("No longer supported", macos(10.0, 10.6)) MIDI_API_UNAVAILABLE_NON_MACOS; ; macOS 10.0+, deprecated macOS 10.6
   documentation: @function MIDISetupGetCurrent Return the system's current MIDISetup. As of CoreMIDI 1.1, it is usually not necessary to call this function, as CoreMIDI manages a single persistent MIDISetup itself. outSetup On successful return, points to the system's most recently installed MIDISetup. The system retains ownership of the object; the client must <b>

41. [a:swift:ColorSync::35:ColorSync.HeadroomAdaptiveGainCurve.ColorVolumeTransform.customHDRReferenceWhite]
   framework: ColorSync   member of: HeadroomAdaptiveGainCurve.ColorVolumeTransform
   name: customHDRReferenceWhite   kind: var
   declaration: var public var customHDRReferenceWhite: Swift.Float? ; macOS 27.0+
   documentation: (none)

42. [a:swift:MusicUnderstanding::48:StructureResult]
   framework: MusicUnderstanding   (top level)
   name: StructureResult   kind: struct
   declaration: struct public struct StructureResult : Swift.Codable, Swift.Sendable { ; macOS 27.0+
   documentation: (none)

43. [a:objc:AppKit:NSWritingToolsCoordinator.h:200:NSWritingToolsCoordinatorTextUpdateReason.NSWritingToolsCoordinatorContextScopeVisibleArea]
   framework: AppKit   member of: NSWritingToolsCoordinatorTextUpdateReason
   name: NSWritingToolsCoordinatorContextScopeVisibleArea   kind: enumCase
   declaration: enumCase NSWritingToolsCoordinatorContextScopeVisibleArea, // inline editing on a user visible text; Writing Tools visual effects appear within the text view ; macOS 27.0+
   documentation: some additional text before and after the visible text.

44. [a:swift:AppKit::3733:AppKit.SelectedAlternativeStringMessage.textAlternatives]
   framework: AppKit   member of: SelectedAlternativeStringMessage
   name: textAlternatives   kind: var
   declaration: var public var textAlternatives: AppKit.NSTextAlternatives ; macOS 27.0+
   documentation: (none)

45. [a:swift:PencilKit::35:PKStrokePath.bezierRepresentation]
   framework: PencilKit   member of: PKStrokePath
   name: bezierRepresentation   kind: var
   declaration: var public var bezierRepresentation: CoreGraphics.CGPath { ; macOS 27.0+
   documentation: (none)

46. [a:swift:AppKit::452:AppKit.DidChangeAutomaticTextReplacementMessage]
   framework: AppKit   (top level)
   name: DidChangeAutomaticTextReplacementMessage   kind: struct
   declaration: struct public struct DidChangeAutomaticTextReplacementMessage { ; macOS 27.0+
   documentation: (none)
