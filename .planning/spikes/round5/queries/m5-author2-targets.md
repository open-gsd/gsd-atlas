# M5 targets for author 2

Task context for every query below: You are fixing a compile error, a deprecation warning or a crash and need the declaration that is the correct replacement or the right tool.

1. [a:objc:ARKit:shared_coordinate_space.h:203:ar_shared_coordinate_space_provider_is_supported]
   framework: ARKit   (top level)
   name: ar_shared_coordinate_space_provider_is_supported   kind: function
   declaration: function API_AVAILABLE(visionos(26.0)) AR_EXTERN bool ar_shared_coordinate_space_provider_is_supported(void) AR_REFINED_FOR_SWIFT; ; 
   documentation: Determines whether this device supports the shared coordinate space provider. - Returns: Returns `true` if provider is supported on this device, `false` otherwise.

2. [a:objc:Foundation:NSGeometry.h:174:NSAlignmentOptions.NSAlignMaxXOutward]
   framework: Foundation   member of: NSAlignmentOptions
   name: NSAlignMaxXOutward   kind: enumCase
   declaration: enumCase NSAlignMaxXOutward = 1ULL << 10,
   documentation: Specifies that alignment of the maximum X coordinate should be to the nearest outward integral value.

3. [a:objc:SecurityInterface:SFAuthorizationPluginView.h:201:SFAuthorizationPluginView.setButton:enabled:]
   framework: SecurityInterface   member of: SFAuthorizationPluginView
   name: setButton:enabled:   kind: method
   declaration: method - (void)setButton:(SFButtonType)inButtonType enabled:(BOOL)inEnabled API_AVAILABLE(macos(10.5)) API_UNAVAILABLE(ios, tvos, watchos, macCatalyst); ; macOS 10.5+
   documentation: @method setButton:enabled: The SFAuthorizationPluginView calls this when it would like to disable a button in the UI. inButtonType the type of the button inEnabled YES to enabled the button, NO to disable the button

4. [a:swift:Foundation::10988:Foundation.build_Remainder]
   framework: Foundation   (top level)
   name: build_Remainder   kind: func
   declaration: func public static func build_Remainder<LHS, RHS>(lhs: LHS, rhs: RHS) -> Foundation.PredicateExpressions.Foundation.IntRemainder<LHS, RHS> where LHS : Foundation.PredicateExpression, RHS : Foundation.Predi ; macOS 14+
   documentation: (none)

5. [a:objc:FSKit:FSVolume.h:362:FSStatFSResult.totalFiles]
   framework: FSKit   member of: FSStatFSResult
   name: totalFiles   kind: property
   declaration: property @property uint64_t totalFiles;
   documentation: A property for the total number of file slots in the volume,

6. [a:objc:IOKit:IOPMLib.h:49:IOPMFindPowerManagement]
   framework: IOKit   (top level)
   name: IOPMFindPowerManagement   kind: function
   declaration: function io_connect_t IOPMFindPowerManagement( mach_port_t master_device_port ) AVAILABLE_MAC_OS_X_VERSION_10_0_AND_LATER;
   documentation: @function IOPMFindPowerManagement Finds the Root Power Domain IOService. master_device_port Just pass in MACH_PORT_NULL for master device port. Returns a io_connect_t handle on the root domain. Must be released with IOServiceClose() when done. /

7. [a:swift:SwiftUI::12130:NSHostingView.firstTextLineCenter]
   framework: SwiftUI   member of: NSHostingView
   name: firstTextLineCenter   kind: var
   declaration: var @_Concurrency.MainActor @preconcurrency open var firstTextLineCenter: CoreFoundation.CGFloat? { ; macOS 11.0+
   documentation: (none)

8. [a:swift:AppKit::2578:AppKit.DidChangeMessage.collectionName]
   framework: AppKit   member of: DidChangeMessage
   name: collectionName   kind: var
   declaration: var public var collectionName: Swift.String? ; macOS 27.0+
   documentation: (none)

9. [a:swift:RealityFoundation::15977:PhysicsSimulationComponent.SolverIterations]
   framework: RealityFoundation   member of: PhysicsSimulationComponent
   name: SolverIterations   kind: struct
   declaration: struct public struct SolverIterations : Swift.Equatable { ; macOS 15.0+
   documentation: (none)

10. [a:objc:AVFoundation:AVAssetWriter.h:523:AVAssetWriter.usesProVideoStorage]
   framework: AVFoundation   member of: AVAssetWriter
   name: usesProVideoStorage   kind: property
   declaration: property @property (nonatomic) BOOL usesProVideoStorage API_AVAILABLE(macos(27.0), ios(27.0), macCatalyst(27.0), tvos(27.0)) API_UNAVAILABLE(visionos) API_UNAVAILABLE(watchos); ; macOS 27.0+
   documentation: Indicates whether to use pre-allocated storage. The default value is `NO`. See more detailed description of ProVideoStorage in `AVProVideoStorage.h`. An exception will be thrown if clients try to set `YES` if the value of the `proVideoStorageSupported` property is `NO`. An exception will be thrown if clients try to set this property after `-startWr

11. [a:swift:ManagedAppDistribution::40:ManagedApp.licenseAgreementText]
   framework: ManagedAppDistribution   member of: ManagedApp
   name: licenseAgreementText   kind: var
   declaration: var public var licenseAgreementText: Foundation.AttributedString? { ; macOS 27.0+
   documentation: (none)

12. [a:swift:USDKit::2416:USDKit.TimeCode.isPreTime]
   framework: USDKit   member of: TimeCode
   name: isPreTime   kind: var
   declaration: var public var isPreTime: Swift.Bool { ; macOS 27.0+
   documentation: (none)

13. [a:swift:Foundation::22677:Swift.getBytes]
   framework: Foundation   member of: Swift
   name: getBytes   kind: func
   declaration: func public func getBytes<R>(_ buffer: inout [Swift.UInt8], maxLength maxBufferCount: Swift.Int, usedLength usedBufferCount: Swift.UnsafeMutablePointer<Swift.Int>, encoding: Swift.String.Foundation.Encodin ; macOS 10.10+
   documentation: (none)

14. [a:objc:FSKit:FSResource.h:512:FSProbeResult.usableButLimitedProbeResult]
   framework: FSKit   member of: FSProbeResult
   name: usableButLimitedProbeResult   kind: property
   declaration: property @property (class, readonly) FSProbeResult * usableButLimitedProbeResult;
   documentation: A probe result for a recognized file system that is usable, but with limited capabilities. This kind of probe result lacks the ``FSProbeResult/name``, ``FSProbeResult/containerID``, or both. Don't return this result from probing a resource that isn't limited.

15. [a:swift:CoreTransferable::43:CoreTransferable.suggestedFilename]
   framework: CoreTransferable   (top level)
   name: suggestedFilename   kind: var
   declaration: var public var suggestedFilename: Swift.String? { ; macOS 15.2+
   documentation: (none)

16. [a:objc:CFNetwork:CFHTTPAuthentication.h:35:CFHTTPAuthenticationRef]
   framework: CFNetwork   (top level)
   name: CFHTTPAuthenticationRef   kind: constant
   declaration: constant CF_EXTERN_C_BEGIN CF_ASSUME_NONNULL_BEGIN /* * CFHTTPAuthenticationRef * * Discussion: * This is the type of a reference to HTTP authentication * information. */ typedef struct _CFHTTPAuthentication* 
   documentation: File: CFNetwork/CFHTTPAuthentication.h Contains: CoreFoundation Network HTTP authentication header Copyright: Copyright (c) 2001-2013 Apple Inc. All rights reserved. Bugs?: For bug reports, consult the following page on the World Wide Web: http://developer.apple.com/bugreporter/ /

17. [a:objc:Foundation:NSCalendar.h:767:NSDateComponents.NSDateComponents]
   framework: Foundation   member of: NSDateComponents
   name: NSDateComponents   kind: class
   declaration: class @interface NSDateComponents : NSObject <NSCopying, NSSecureCoding>
   documentation: An object that specifies a date or time in terms of units (such as year, month, day, hour, and minute) to be evaluated in a calendar system and time zone. In Swift, this object bridges to ``DateComponents``; use ``NSDateComponents`` when you need reference semantics or other Foundation-specific behavior. ``NSDateComponents`` encapsulates the compon

18. [a:swift:PaperKit::967:MarkupAdornment]
   framework: PaperKit   (top level)
   name: MarkupAdornment   kind: struct
   declaration: struct public struct MarkupAdornment : Swift.Equatable, Swift.Hashable, Swift.Identifiable, Swift.Sendable { ; macOS 27.0+
   documentation: (none)

19. [a:swift:USDKit::2036:USDTransformOperation.isDefined]
   framework: USDKit   member of: USDTransformOperation
   name: isDefined   kind: var
   declaration: var public var isDefined: Swift.Bool { ; macOS 27.0+
   documentation: (none)

20. [a:objc:FSKit:FSResource.h:455:FSManageableResourceMaintenanceOperations.startFormatWithTask:options:error:]
   framework: FSKit   member of: FSManageableResourceMaintenanceOperations
   name: startFormatWithTask:options:error:   kind: method
   declaration: method -(NSProgress * _Nullable)startFormatWithTask:(FSTask *)task options:(FSTaskOptions *)options error:(NSError**)error FSKIT_API_AVAILABILITY_V1 NS_SWIFT_NAME(startFormat(task:options:));
   documentation: Starts formatting the file system with the given options. - Parameters: - task: A task object you use to communicate back to the client. - options: Options for performing the format. - error: In Objective-C, a pointer to an <doc://com.apple.documentation/documentation/Foundation/NSError>. Populate this with any error that occurs when starting the f

21. [a:swift:USDKit::5671:USDKit.ChangeList.Entry.Flags.didRename]
   framework: USDKit   member of: ChangeList.Entry.Flags
   name: didRename   kind: var
   declaration: var public var didRename: Swift.Bool { ; macOS 27.0+
   documentation: (none)

22. [a:objc:Foundation:NSNumberFormatter.h:265:NSNumberFormatter.negativePrefix]
   framework: Foundation   member of: NSNumberFormatter
   name: negativePrefix   kind: property
   declaration: property @property (null_resettable, copy) NSString *negativePrefix;
   documentation: The string the receiver uses as a prefix for negative values.

23. [a:swift:SwiftUICore::25274:GestureInputKinds]
   framework: SwiftUICore   (top level)
   name: GestureInputKinds   kind: struct
   declaration: struct public struct GestureInputKinds : Swift.OptionSet, Swift.Sendable { ; macOS 27.0+
   documentation: (none)

24. [a:swift:Network::1522:DTLS]
   framework: Network   (top level)
   name: DTLS   kind: struct
   declaration: struct public struct DTLS : Network.DatagramProtocol { ; macOS 27.0+
   documentation: (none)

25. [a:objc:Foundation:NSRunLoop.h:60:NSRunLoop.addTimer:forMode:]
   framework: Foundation   member of: NSRunLoop
   name: addTimer:forMode:   kind: method
   declaration: method - (void)addTimer:(NSTimer *)timer forMode:(NSRunLoopMode)mode;
   documentation: Registers a given timer with a given input mode. - Parameters: - timer: The timer to register with the receiver. - mode: The mode in which to add the timer. You may specify a custom mode or use one of the modes listed in ``RunLoop/Mode``. You can add a timer to multiple input modes. While running in the designated mode, the receiver causes the time

26. [a:swift:Foundation::9730:Foundation.egypt]
   framework: Foundation   (top level)
   name: egypt   kind: var
   declaration: var @_alwaysEmitIntoClient public static var egypt: Foundation.Locale.Foundation.Region { ; macOS 13+
   documentation: (none)

27. [a:swift:AppKit::3690:AppKit.WillAddItemMessage]
   framework: AppKit   (top level)
   name: WillAddItemMessage   kind: struct
   declaration: struct public struct WillAddItemMessage : Foundation.NotificationCenter.Foundation.MainActorMessage { ; macOS 27.0+
   documentation: (none)

28. [a:objc:Foundation:NSScanner.h:224:NSScanner.scanUpToCharactersFromSet:intoString:]
   framework: Foundation   member of: NSScanner
   name: scanUpToCharactersFromSet:intoString:   kind: method
   declaration: method - (BOOL)scanUpToCharactersFromSet:(NSCharacterSet *)set intoString:(NSString * _Nullable * _Nullable)result _NS_SCANNER_DEPRECATED_FOR_SWIFT_ONLY_WITH_REPLACEMENT("scanUpToCharacters(from:)", macos(10 ; macOS 10.0+
   documentation: Scans the string until a character from a given character set is encountered, accumulating characters into a string that's returned by reference. Invoke this method with `NULL` as `stringValue` to simply scan up to a given set of characters. If no characters in `stopSet` are present in the scanner's source string, the remainder of the source string

29. [a:swift:PaperKit::358:PaperKit.Shape.ChatBubble.tailLocation]
   framework: PaperKit   member of: Shape.ChatBubble
   name: tailLocation   kind: var
   declaration: var public var tailLocation: CoreFoundation.CGPoint ; macOS 27.0+
   documentation: (none)

30. [a:swift:Foundation::12161:PropertyListDecoder]
   framework: Foundation   (top level)
   name: PropertyListDecoder   kind: class
   declaration: class @_objcRuntimeName(_TtC10Foundation20_PropertyListDecoder) open class PropertyListDecoder { ; macOS 10.10+
   documentation: (none)

31. [a:swift:RealityFoundation::16151:BehaviorTreeActionHandler.actionTerminatedWithResult]
   framework: RealityFoundation   member of: BehaviorTreeActionHandler
   name: actionTerminatedWithResult   kind: func
   declaration: func mutating func actionTerminatedWithResult(event: Self.EventType) -> RealityFoundation.ActionResult? ; macOS 27.0+
   documentation: (none)

32. [a:swift:CreateMLComponents::1633:TemporalSegmentIdentifier]
   framework: CreateMLComponents   (top level)
   name: TemporalSegmentIdentifier   kind: struct
   declaration: struct public struct TemporalSegmentIdentifier : Swift.Hashable, Swift.Sendable { ; macOS 13.0+
   documentation: (none)

33. [a:swift:CoreVideo::48:CVAttachmentModePreferenceShouldNotPropagate]
   framework: CoreVideo   (top level)
   name: CVAttachmentModePreferenceShouldNotPropagate   kind: enum
   declaration: enum public enum CVAttachmentModePreferenceShouldNotPropagate : CoreVideo.CVAttachmentModePreference { ; macOS 27.0+
   documentation: (none)

34. [a:objc:NetworkExtension:NEDNSProxyManager.h:41:NEDNSProxyManagerError.NEDNSProxyManagerErrorConfigurationCannotBeRemoved]
   framework: NetworkExtension   member of: NEDNSProxyManagerError
   name: NEDNSProxyManagerErrorConfigurationCannotBeRemoved   kind: enumCase
   declaration: enumCase NEDNSProxyManagerErrorConfigurationCannotBeRemoved = 4, ; macOS 10.15+
   documentation: NEDNSProxyManagerErrorConfigurationCannotBeRemoved The DNS proxy configuration cannot be removed.

35. [a:objc:Foundation:NSIndexPath.h:53:NSIndexPath.initWithIndex:]
   framework: Foundation   member of: NSIndexPath
   name: initWithIndex:   kind: method
   declaration: method - (instancetype)initWithIndex:(NSUInteger)index;
   documentation: Initializes an index path with a single node. - Parameter index: Index of the item in node 0 to point to. - Returns: Initialized `NSIndexPath` object representing a one-node index path with `index`.

36. [a:objc:CoreMedia:CMSampleBuffer.h:1390:CMSampleBufferGetSampleTimingInfo]
   framework: CoreMedia   (top level)
   name: CMSampleBufferGetSampleTimingInfo   kind: function
   declaration: function CM_EXPORT OSStatus CMSampleBufferGetSampleTimingInfo( CMSampleBufferRef CM_NONNULL sbuf, /*! @param sbuf CMSampleBuffer being interrogated */ CMItemIndex sampleIndex, /*! @param sampleIndex Sample ind ; macOS 10.7+
   documentation: @function CMSampleBufferGetSampleTimingInfo Returns a CMSampleTimingInfo struct describing a specified sample in a CMSampleBuffer. A sample-specific CMSampleTimingInfo struct will be returned (ie. with a sample-specific presentationTimeStamp and decodeTimeStamp), even if a single CMSampleTimingInfo struct was used during creation to describe all th

37. [a:objc:UniformTypeIdentifiers:UTCoreTypes.h:498:UTTypePropertyList]
   framework: UniformTypeIdentifiers   (top level)
   name: UTTypePropertyList   kind: constant
   declaration: constant UT_EXPORT UTType *const UTTypePropertyList NS_REFINED_FOR_SWIFT;
   documentation: \brief A base type for property lists. UTI: com.apple.property-list conforms to: public.data

38. [a:swift:MediaIntelligence::51:Face]
   framework: MediaIntelligence   (top level)
   name: Face   kind: struct
   declaration: struct public struct Face : Swift.Codable, Swift.Sendable { ; macOS 27.0+
   documentation: (none)

39. [a:swift:ComputeGraph::827:ElementGrouping]
   framework: ComputeGraph   (top level)
   name: ElementGrouping   kind: enum
   declaration: enum public enum ElementGrouping : Swift.String, Swift.CaseIterable, Swift.Sendable, Swift.Codable { ; macOS 27.0+
   documentation: (none)

40. [a:objc:CoreImage:CIFilterBuiltins.h:2029:CILineOverlay.CILineOverlay]
   framework: CoreImage   member of: CILineOverlay
   name: CILineOverlay   kind: protocol
   declaration: protocol @protocol CILineOverlay <CIFilter>
   documentation: The protocol for the Line Overlay filter. Creates a sketch that outlines the edges of an image in black, leaving the non-outlined portions of the image transparent. The result has alpha and is rendered in black, so it won’t look like much until you render it over another image using source over compositing.

41. [a:objc:Foundation:NSURL.h:1218:NSURL.percentEncodedUser]
   framework: Foundation   member of: NSURL
   name: percentEncodedUser   kind: property
   declaration: property @property (nullable, copy) NSString *percentEncodedUser;
   documentation: The username URL subcomponent expressed as a URL-encoded string, or `nil` if not present. If you set this value to something that is not a valid, percent-encoded string, this class throws an exception.

42. [a:swift:MetricKit::144:CallStackTree.BinaryInfo]
   framework: MetricKit   member of: CallStackTree
   name: BinaryInfo   kind: struct
   declaration: struct public struct BinaryInfo : Swift.Sendable, Swift.Codable, Swift.Hashable { ; macOS 27.0+
   documentation: (none)

43. [a:objc:AudioToolbox:MusicPlayer.h:964:MusicSequenceFileCreate]
   framework: AudioToolbox   (top level)
   name: MusicSequenceFileCreate   kind: function
   declaration: function extern OSStatus MusicSequenceFileCreate (MusicSequence inSequence, CFURLRef inFileRef, MusicSequenceFileTypeID inFileType, MusicSequenceFileFlags inFlags, SInt16 inResolution) API_AVAILABLE(macos(10.5 ; macOS 10.5+
   documentation: @function MusicSequenceFileCreate Create a file from a sequence This function can be (and is most commonly) used to create a MIDI file from the events in a sequence. Only MIDI based events are used when creating the MIDI file. MIDI files are normally beat based, but can also have a SMPTE (or real-time rather than beat time) representation. inResolu

44. [a:objc:CoreAudio:AudioHardware.h:1505:AudioDeviceTranslateTime]
   framework: CoreAudio   (top level)
   name: AudioDeviceTranslateTime   kind: function
   declaration: function extern OSStatus AudioDeviceTranslateTime( AudioObjectID inDevice, const AudioTimeStamp* inTime, AudioTimeStamp* outTime) CA_REALTIME_API __OSX_AVAILABLE_STARTING(__MAC_10_0, __IPHONE_2_0);
   documentation: @function AudioDeviceTranslateTime Translates the time in the AudioDevice's time base from one representation to another. Note that the device has to be running inDevice The AudioDevice whose time base governs the translation. inTime An AudioTimeStamp containing the time to be translated. outTime An AudioTimeStamp into which the translated time is 

45. [a:swift:NowPlaying::458:TVShowContent]
   framework: NowPlaying   (top level)
   name: TVShowContent   kind: struct
   declaration: struct public struct TVShowContent : NowPlaying.MediaContentRepresentable { ; macOS 27+
   documentation: (none)

46. [a:objc:Security:SecStaticCode.h:79:SecStaticCodeCreateWithPath]
   framework: Security   (top level)
   name: SecStaticCodeCreateWithPath   kind: function
   declaration: function OSStatus SecStaticCodeCreateWithPath(CFURLRef path, SecCSFlags flags, SecStaticCodeRef * __nonnull CF_RETURNS_RETAINED staticCode);
   documentation: @function SecStaticCodeCreateWithPath Given a path to a file system object, create a SecStaticCode object representing the code at that location, if possible. Such a SecStaticCode is not inherently linked to running code in the system. It is possible to create a SecStaticCode object from an unsigned code object. Most uses of such an object will ret
