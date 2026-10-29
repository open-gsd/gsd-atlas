# M4 targets for author 2

1. [a:swift:AppIntents::3122:AppIntents.ExecutionTargets]
   framework: AppIntents   (top level)
   name: ExecutionTargets   kind: typealias
   declaration: typealias public typealias ExecutionTargets = AppIntents.IntentExecutionTargets ; macOS 27.0+
   documentation: (none)

2. [a:objc:Foundation:NSXMLElement.h:128:NSXMLElement.attributeForName:]
   framework: Foundation   member of: NSXMLElement
   name: attributeForName:   kind: method
   declaration: method - (nullable NSXMLNode *)attributeForName:(NSString *)name;
   documentation: Returns the attribute node of the receiver with the specified name. If @c name is a qualified name, then this method invokes @c attributeForLocalName:URI: with the URI parameter set to the URI associated with the prefix. Otherwise comparison is based on string equality of the qualified or non-qualified name. name A string specifying the name of an 

3. [a:objc:AudioToolbox:AUComponent.h:732:AudioUnitRenderActionFlags]
   framework: AudioToolbox   (top level)
   name: AudioUnitRenderActionFlags   kind: enum
   declaration: enum typedef CF_OPTIONS(UInt32, AudioUnitRenderActionFlags) { kAudioUnitRenderAction_PreRender = (1UL << 2), kAudioUnitRenderAction_PostRender = (1UL << 3), kAudioUnitRenderAction_OutputIsSilence = (1UL <<
   documentation: @enum AudioUnitRenderActionFlags These flags can be set in a callback from an audio unit during an audio unit render operation from either the RenderNotify Proc or the render input callback. kAudioUnitRenderAction_PreRender Called on a render notification Proc - which is called either before or after the render operation of the audio unit. If this 

4. [a:swift:USDKit::1578:USDKit.ValueType.textureCoordinate3d]
   framework: USDKit   member of: ValueType
   name: textureCoordinate3d   kind: var
   declaration: var public static var textureCoordinate3d: USDKit.USDPrim.USDKit.Attribute.USDKit.ValueType { ; macOS 27.0+
   documentation: (none)

5. [a:swift:Foundation::17403:URLRequest.mainDocumentURL]
   framework: Foundation   member of: URLRequest
   name: mainDocumentURL   kind: var
   declaration: var public var mainDocumentURL: Foundation.URL? { ; macOS 10.10+
   documentation: (none)

6. [a:objc:Hypervisor:hv_vcpu.h:428:hv_vcpu_get_wait_for_interrupt_time]
   framework: Hypervisor   (top level)
   name: hv_vcpu_get_wait_for_interrupt_time   kind: function
   declaration: function OS_EXPORT API_AVAILABLE(macos(27.0)) hv_return_t hv_vcpu_get_wait_for_interrupt_time(hv_vcpu_t vcpu, uint64_t *time); ; macOS 27.0+
   documentation: Returns the cumulative wait time of a vCPU spent at WFI instruction while waiting for interrupts in the units of mach_absolute_time(). vcpu ID of the vcpu instance. time Pointer to wait time value (written on success). HV_SUCCESS on success, error code otherwise. Must be called by the owning thread. Returns HV_UNSUPPORTED if the VM was created with

7. [a:objc:AppKit:NSTextView.h:216:NSTextView.startSpeaking:]
   framework: AppKit   member of: NSTextView
   name: startSpeaking:   kind: method
   declaration: method - (void)startSpeaking:(nullable id)sender;
   documentation: *********************** Speech support ************************

8. [a:swift:USDKit::5653:USDKit.ChangeList.Entry.Flags.didChangeIdentifier]
   framework: USDKit   member of: ChangeList.Entry.Flags
   name: didChangeIdentifier   kind: var
   declaration: var public var didChangeIdentifier: Swift.Bool { ; macOS 27.0+
   documentation: (none)

9. [a:swift:USDKit::5633:USDKit.ChangeList]
   framework: USDKit   (top level)
   name: ChangeList   kind: struct
   declaration: struct public struct ChangeList { ; macOS 27.0+
   documentation: (none)

10. [a:objc:AppKit:NSWritingToolsCoordinator.h:104:NSWritingToolsCoordinatorTextUpdateReason.NSWritingToolsCoordinatorStateInteractiveResting]
   framework: AppKit   member of: NSWritingToolsCoordinatorTextUpdateReason
   name: NSWritingToolsCoordinatorStateInteractiveResting   kind: enumCase
   declaration: enumCase NSWritingToolsCoordinatorStateInteractiveResting, // Writing Tools is providing the full inline-editing experience, and has delivered a complete set of results. ; macOS 27.0+
   documentation: the coordinator transitions from this state to the ``inactive`` state.

11. [a:objc:ARKit:accessory_tracking.h:245:ar_accessory_load_from_device]
   framework: ARKit   (top level)
   name: ar_accessory_load_from_device   kind: function
   declaration: function API_AVAILABLE(visionos(26.0)) AR_EXTERN void ar_accessory_load_from_device(id<GCDevice> device, ar_accessory_device_load_completion_handler_t completion_handler) AR_REFINED_FOR_SWIFT; ; 
   documentation: Load an accessory from a `GCDevice`. - Parameters: - device: The `GCDevice` for which to load the accessory. - completion_handler: A handler triggered after the request to load an accessory completes.

12. [a:objc:AppKit:NSWritingToolsCoordinator.h:238:NSWritingToolsCoordinatorTextUpdateReason.NSWritingToolsCoordinatorTextAnimationInsert]
   framework: AppKit   member of: NSWritingToolsCoordinatorTextUpdateReason
   name: NSWritingToolsCoordinatorTextAnimationInsert   kind: enumCase
   declaration: enumCase NSWritingToolsCoordinatorTextAnimationInsert, // The animation effect for washing in replacement text from a Writing Tools delivery ; macOS 27.0+
   documentation: object you provide to animate the insertion of the text.

13. [a:objc:Metal:MTLAccelerationStructure.h:474:MTLCurveType.MTLCurveTypeFlat]
   framework: Metal   member of: MTLCurveType
   name: MTLCurveTypeFlat   kind: enumCase
   declaration: enumCase MTLCurveTypeFlat = 1, ; macOS 12.0+
   documentation: Curve with a flat cross-section aligned with the ray direction. These curves may be faster to intersect but do not have a consistent 3D structure across different rays. These curves are ideal for viewing at a distance or curves with a small radius such as hair and fur. /

14. [a:objc:IOUSBHost:IOUSBHostStream.h:37:IOUSBHostStream.abortWithOption:error:]
   framework: IOUSBHost   member of: IOUSBHostStream
   name: abortWithOption:error:   kind: method
   declaration: method -(BOOL)abortWithOption:(IOUSBHostAbortOption)option error:(NSError* _Nullable*)error;
   documentation: Abort pending I/O requests. A stream context must be set as non-active on the device via an out-of-band (class-defined) mechanism before this method is called (USB 3.1 8.12.1.4). A non-active stream will not be selected by the device to become the current stream on the endpoint. option IOUSBHostAbortOption by default IOUSBHostAbortOptionSynchronous

15. [a:objc:Foundation:NSString.h:1289:NSString.getCString:]
   framework: Foundation   member of: NSString
   name: getCString:   kind: method
   declaration: method - (void)getCString:(char *)bytes API_DEPRECATED("Use -getCString:maxLength:encoding: instead", macos(10.0,10.4), ios(2.0,2.0), watchos(2.0,2.0), tvos(9.0,9.0)); ; macOS 10.0+, deprecated macOS 10.4
   documentation: Copies the receiver's C-string representation into a given buffer. @deprecated Use @c getCString:maxLength:encoding: instead.

16. [a:objc:CoreMedia:CMGenlockClock.h:37:CMIsAnyDisplaySynchronizedToLockedGenlockSignal]
   framework: CoreMedia   (top level)
   name: CMIsAnyDisplaySynchronizedToLockedGenlockSignal   kind: function
   declaration: function CM_EXPORT Boolean CMIsAnyDisplaySynchronizedToLockedGenlockSignal(void) CM_REFINED_FOR_SWIFT API_AVAILABLE(macos(27.0), macCatalyst(27.0)) API_UNAVAILABLE(ios, tvos, watchos, visionos); ; macOS 27.0+
   documentation: Queries whether any display is synchronized to a locked external genlock signal.

17. [a:swift:CoreHID::177:HIDDeviceManager.DeviceMatchingCriteria]
   framework: CoreHID   member of: HIDDeviceManager
   name: DeviceMatchingCriteria   kind: struct
   declaration: struct public struct DeviceMatchingCriteria : Swift.Sendable { ; macOS 15+
   documentation: (none)

18. [a:swift:PaperKit::722:FeatureSet.shapes]
   framework: PaperKit   member of: FeatureSet
   name: shapes   kind: var
   declaration: var public var shapes: Swift.Set<PaperKit.ShapeConfiguration.PaperKit.Shape> ; macOS 26.0+
   documentation: (none)

19. [a:objc:Foundation:NSPathUtilities.h:129:NSString.fileSystemRepresentation]
   framework: Foundation   member of: NSString
   name: fileSystemRepresentation   kind: property
   declaration: property @property (readonly) const char *fileSystemRepresentation NS_RETURNS_INNER_POINTER;
   documentation: A file system-specific representation of the receiver. The returned C string will be automatically freed just as a returned object would be released; your code should copy the representation or use ``NSString/getFileSystemRepresentation(_:maxLength:)`` if it needs to store it outside of the autorelease context. Raises ``NSExceptionName/characterCon

20. [a:swift:CoreData::1276:Foundation.didSaveObjectIDsAsync]
   framework: CoreData   member of: Foundation
   name: didSaveObjectIDsAsync   kind: var
   declaration: var public static var didSaveObjectIDsAsync: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<CoreData.NSManagedObjectContext.CoreData.DidSaveObjectIDsAsyncMessage> { ; macOS 27.0+
   documentation: (none)

21. [a:objc:Hypervisor:hv_gic.h:238:hv_gic_get_msi_reg]
   framework: Hypervisor   (top level)
   name: hv_gic_get_msi_reg   kind: function
   declaration: function OS_EXPORT API_AVAILABLE(macos(15.0)) hv_return_t hv_gic_get_msi_reg(hv_gic_msi_reg_t reg, uint64_t *value); ; macOS 15.0+
   documentation: Read a GIC distributor MSI register. reg GIC distributor MSI register enum. value Pointer to distributor MSI register value (written on success). HV_SUCCESS on success, an error code otherwise. /

22. [a:objc:ExternalAccessory:EAWiFiUnconfiguredAccessoryBrowser.h:154:EAWiFiUnconfiguredAccessoryBrowserDelegate.EAWiFiUnconfiguredAccessoryBrowserDelegate]
   framework: ExternalAccessory   member of: EAWiFiUnconfiguredAccessoryBrowserDelegate
   name: EAWiFiUnconfiguredAccessoryBrowserDelegate   kind: protocol
   declaration: protocol @protocol EAWiFiUnconfiguredAccessoryBrowserDelegate <NSObject>
   documentation: @protocol EAWiFiUnconfiguredAccessoryBrowserDelegate The delegate of a EAWiFiUnconfiguredAccessoryBrowser object must adopt the EAWiFiUnconfiguredAccessoryBrowserDelegate protocol. The required callbacks keep the delegate informed of the state of the search and configuration processes. /

23. [a:objc:Matter:MTRBaseClusters.h:8644:MTRBaseClusterElectricalProtectionAlarm.modifyEnabledAlarmsWithParams:completion:]
   framework: Matter   member of: MTRBaseClusterElectricalProtectionAlarm
   name: modifyEnabledAlarmsWithParams:completion:   kind: method
   declaration: method - (void)modifyEnabledAlarmsWithParams:(MTRElectricalProtectionAlarmClusterModifyEnabledAlarmsParams *)params completion:(MTRStatusCompletion)completion MTR_PROVISIONALLY_AVAILABLE;
   documentation: Command ModifyEnabledAlarms This command allows a client to request that an alarm be enabled or suppressed at the server. /

24. [a:swift:Foundation::13015:URL.standardized]
   framework: Foundation   member of: URL
   name: standardized   kind: var
   declaration: var public var standardized: Foundation.URL { ; macOS 10.10+
   documentation: (none)

25. [a:swift:Foundation::9427:Foundation.romanian]
   framework: Foundation   (top level)
   name: romanian   kind: var
   declaration: var @_alwaysEmitIntoClient public static var romanian: Foundation.Locale.Foundation.LanguageCode { ; macOS 13+
   documentation: (none)

26. [a:objc:AppKit:NSTextList.h:24:NSTextListOptions.NSTextListPrependEnclosingMarker]
   framework: AppKit   member of: NSTextListOptions
   name: NSTextListPrependEnclosingMarker   kind: enumCase
   declaration: enumCase NSTextListPrependEnclosingMarker API_AVAILABLE(macos(10.0), ios(7.0), tvos(9.0), watchos(2.0), visionos(1.0)) = (1 << 0), ; macOS 10.0+
   documentation: Specifies that a nested list should include the marker for its enclosing superlist before its own marker.

27. [a:objc:CoreAudio:AudioHardware.h:346:AudioObjectAddPropertyListener]
   framework: CoreAudio   (top level)
   name: AudioObjectAddPropertyListener   kind: function
   declaration: function extern OSStatus AudioObjectAddPropertyListener( AudioObjectID inObjectID, const AudioObjectPropertyAddress* inAddress, AudioObjectPropertyListenerProc inListener, void* __nullable inClientData) __OSX_
   documentation: @function AudioObjectAddPropertyListener Registers the given AudioObjectPropertyListenerProc to receive notifications when the given properties change. inObjectID The AudioObject to register the listener with. inAddress The AudioObjectPropertyAddresses indicating which property the listener should be notified about. inListener The AudioObjectProper

28. [a:swift:AppKit::2951:Foundation.willBeginSheet]
   framework: AppKit   member of: Foundation
   name: willBeginSheet   kind: var
   declaration: var @_alwaysEmitIntoClient public static var willBeginSheet: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSWindow.AppKit.WillBeginSheetMessage> { ; macOS 27.0+
   documentation: (none)

29. [a:objc:MetalFX:MTLFXTemporalScaler.h:252:MTLFXTemporalScalerBase.motionContentOffsetY]
   framework: MetalFX   member of: MTLFXTemporalScalerBase
   name: motionContentOffsetY   kind: property
   declaration: property @property (nonatomic) NSUInteger motionContentOffsetY API_AVAILABLE(macos(27.0), ios(27.0)) API_UNAVAILABLE(visionos); ; macOS 27.0+
   documentation: The vertical offset, in pixels, of the region within the motion texture to use as input.

30. [a:swift:WeatherKit::992:HourTemperatureStatistics]
   framework: WeatherKit   (top level)
   name: HourTemperatureStatistics   kind: struct
   declaration: struct public struct HourTemperatureStatistics : Swift.Codable, Swift.Equatable, Swift.Sendable { ; macOS 15.0+
   documentation: (none)

31. [a:objc:MediaAccessibility:MACaptionAppearance.h:106:MACaptionAppearanceFontStyle]
   framework: MediaAccessibility   (top level)
   name: MACaptionAppearanceFontStyle   kind: enum
   declaration: enum typedef CF_ENUM(CFIndex, MACaptionAppearanceFontStyle) { kMACaptionAppearanceFontStyleDefault = 0, kMACaptionAppearanceFontStyleMonospacedWithSerif = 1, kMACaptionAppearanceFontStyleProportionalWithSe
   documentation: @enum MACaptionAppearanceFontStyle MACaptionAppearanceFontStyle is used to specify a font style kMACaptionAppearanceFontStyleDefault Default font style. kMACaptionAppearanceFontStyleMonospacedWithSerif Font style for fonts similar to Courier. kMACaptionAppearanceFontStyleProportionalWithSerif Font style for fonts similar to Times New Roman. kMACapt

32. [a:objc:Metal:MTLCommandEncoder.h:60:MTLResourceUsage.MTLStageResourceState]
   framework: Metal   member of: MTLResourceUsage
   name: MTLStageResourceState   kind: enumCase
   declaration: enumCase MTLStageResourceState = 1 << 26, ; macOS 26.0+
   documentation: Represents all sparse and placement sparse resource mapping updates.

33. [a:swift:USDKit::1774:USDKit.Property.baseName]
   framework: USDKit   member of: Property
   name: baseName   kind: var
   declaration: var public var baseName: USDKit.USDToken { ; macOS 27.0+
   documentation: (none)

34. [a:swift:StoreKit::951:Storefront]
   framework: StoreKit   (top level)
   name: Storefront   kind: struct
   declaration: struct public struct Storefront : Swift.Identifiable, Swift.Sendable { ; macOS 12.0+
   documentation: (none)

35. [a:swift:CoreMedia::136:CMAttachmentValueRepresentable]
   framework: CoreMedia   (top level)
   name: CMAttachmentValueRepresentable   kind: typealias
   declaration: typealias public typealias CMAttachmentValueRepresentable = CoreVideo.CVAttachmentValueRepresentable ; macOS 27.0+
   documentation: (none)

36. [a:swift:USDKit::1524:USDKit.ValueType.vector3h]
   framework: USDKit   member of: ValueType
   name: vector3h   kind: var
   declaration: var public static var vector3h: USDKit.USDPrim.USDKit.Attribute.USDKit.ValueType { ; macOS 27.0+
   documentation: (none)
