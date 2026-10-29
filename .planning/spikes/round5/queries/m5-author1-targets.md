# M5 targets for author 1

Task context for every query below: You are building a new feature and need to find the right declaration to build it with.

1. [a:swift:MetricKit::678:TotalWiFiUploadMetric]
   framework: MetricKit   (top level)
   name: TotalWiFiUploadMetric   kind: struct
   declaration: struct public struct TotalWiFiUploadMetric : Swift.Sendable, Swift.Codable, Swift.Hashable { ; macOS 27.0+
   documentation: (none)

2. [a:objc:Foundation:NSArray.h:108:NSArray.objectAtIndex:]
   framework: Foundation   member of: NSArray
   name: objectAtIndex:   kind: method
   declaration: method - (ObjectType)objectAtIndex:(NSUInteger)index;
   documentation: Returns the object located at the specified index. If `index` is beyond the end of the array (that is, if `index` is greater than or equal to the value returned by `count`), an `NSRangeException` is raised. - Parameter index: An index within the bounds of the array. - Returns: The object located at `index`.

3. [a:objc:MetalFX:MTLFXTemporalScaler.h:257:MTLFXTemporalScalerBase.reactiveMaskContentOffsetY]
   framework: MetalFX   member of: MTLFXTemporalScalerBase
   name: reactiveMaskContentOffsetY   kind: property
   declaration: property @property (nonatomic) NSUInteger reactiveMaskContentOffsetY API_AVAILABLE(macos(27.0), ios(27.0)) API_UNAVAILABLE(visionos); ; macOS 27.0+
   documentation: The vertical offset, in pixels, of the region within the reactive mask texture to use as input.

4. [a:swift:USDKit::4335:USDKit.Vec4f]
   framework: USDKit   (top level)
   name: Vec4f   kind: struct
   declaration: struct @frozen public struct Vec4f : Swift.Sendable { ; macOS 27.0+
   documentation: (none)

5. [a:swift:SwiftUI::1798:WritableDocument]
   framework: SwiftUI   (top level)
   name: WritableDocument   kind: protocol
   declaration: protocol public protocol WritableDocument : AnyObject { ; macOS 27.0+
   documentation: (none)

6. [a:swift:Foundation::9283:Foundation.fula]
   framework: Foundation   (top level)
   name: fula   kind: var
   declaration: var @_alwaysEmitIntoClient public static var fula: Foundation.Locale.Foundation.LanguageCode { ; macOS 13+
   documentation: (none)

7. [a:swift:USDKit::1264:USDPrim.hasAPISchema]
   framework: USDKit   member of: USDPrim
   name: hasAPISchema   kind: func
   declaration: func public func hasAPISchema(_ schemaIdentifier: USDKit.USDToken) -> Swift.Bool ; macOS 27.0+
   documentation: (none)

8. [a:objc:CoreImage:CIFilterBuiltins.h:714:CISystemToneMap.preferredDynamicRange]
   framework: CoreImage   member of: CISystemToneMap
   name: preferredDynamicRange   kind: property
   declaration: property @property (nonatomic, retain, nullable) CIDynamicRangeOption preferredDynamicRange;
   documentation: Specifies the preferred dynamic range behavior of the tone mapping. The value should be kCIDynamicRangeStandard, kCIDynamicRangeConstrainedHigh, kCIDynamicRangeHigh or nil. If nil then it will behave as kCIDynamicRangeHigh.

9. [a:objc:CoreMedia:CMTime.h:76:CMTimeFlags]
   framework: CoreMedia   (top level)
   name: CMTimeFlags   kind: enum
   declaration: enum typedef CF_OPTIONS( uint32_t, CMTimeFlags ) { kCMTimeFlags_Valid = 1UL<<0, kCMTimeFlags_HasBeenRounded = 1UL<<1, kCMTimeFlags_PositiveInfinity = 1UL<<2, kCMTimeFlags_NegativeInfinity = 1UL<<3, kCMTime ; macOS 10.7+
   documentation: @enum CMTimeFlags Flag bits for a CMTime. kCMTimeFlags_Valid Must be set, or the CMTime is considered invalid. Allows simple clearing (eg. with calloc or memset) for initialization of arrays of CMTime structs to "invalid". This flag must be set, even if other flags are set as well. kCMTimeFlags_HasBeenRounded Set whenever a CMTime value is rounded,

10. [a:swift:CompositorServices::230:LayerRendererConfigurationError]
   framework: CompositorServices   (top level)
   name: LayerRendererConfigurationError   kind: enum
   declaration: enum public enum LayerRendererConfigurationError : Swift.Int, Foundation.LocalizedError { ; macOS 26.0+
   documentation: (none)

11. [a:objc:MetalFX:MTLFXTemporalScaler.h:240:MTLFXTemporalScalerBase.colorContentOffsetX]
   framework: MetalFX   member of: MTLFXTemporalScalerBase
   name: colorContentOffsetX   kind: property
   declaration: property @property (nonatomic) NSUInteger colorContentOffsetX API_AVAILABLE(macos(27.0), ios(27.0)) API_UNAVAILABLE(visionos); ; macOS 27.0+
   documentation: The horizontal offset, in pixels, of the region within the color texture to use as input.

12. [a:swift:ComputeGraph::651:ComputeGraph.ArrayDefinition]
   framework: ComputeGraph   (top level)
   name: ArrayDefinition   kind: struct
   declaration: struct public struct ArrayDefinition : Swift.Sendable, Swift.Equatable { ; macOS 27.0+
   documentation: (none)

13. [a:swift:NetworkExtension::105:NEURLFilterManager.ParsingConfiguration.DomainOptions.stripWWW]
   framework: NetworkExtension   member of: NEURLFilterManager.ParsingConfiguration.DomainOptions
   name: stripWWW   kind: var
   declaration: var public var stripWWW: Swift.Bool ; macOS 27.0+
   documentation: (none)

14. [a:objc:AppKit:NSWritingToolsCoordinator.h:161:NSWritingToolsCoordinatorTextUpdateReason.NSWritingToolsCoordinatorTextReplacementReasonRejected]
   framework: AppKit   member of: NSWritingToolsCoordinatorTextUpdateReason
   name: NSWritingToolsCoordinatorTextReplacementReasonRejected   kind: enumCase
   declaration: enumCase NSWritingToolsCoordinatorTextReplacementReasonRejected API_AVAILABLE(macos(27.0)) = 3, // a replacement from grammar presentation, representing rejection of a proposed suggestion, which should subsequ ; macOS 27.0+
   documentation: to make sure that the suggestion will continue to be ignored.

15. [a:objc:CoreFoundation:CFSet.h:56:CFSetEqualCallBack]
   framework: CoreFoundation   (top level)
   name: CFSetEqualCallBack   kind: typedef
   declaration: typedef typedef Boolean (*CFSetEqualCallBack)(const void *value1, const void *value2);
   documentation: @typedef CFSetEqualCallBack Type of the callback function used by CFSets for comparing values. value1 The first value to compare. value2 The second value to compare. True if the values are equal, otherwise false.

16. [a:swift:AppKit::2969:Foundation.didChangeScreenProfile]
   framework: AppKit   member of: Foundation
   name: didChangeScreenProfile   kind: var
   declaration: var @_alwaysEmitIntoClient public static var didChangeScreenProfile: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSWindow.AppKit.DidChangeScreenProfileMessage> { ; macOS 27.0+
   documentation: (none)

17. [a:swift:AppKit::2939:Foundation.willMiniaturize]
   framework: AppKit   member of: Foundation
   name: willMiniaturize   kind: var
   declaration: var @_alwaysEmitIntoClient public static var willMiniaturize: Foundation.NotificationCenter.Foundation.BaseMessageIdentifier<AppKit.NSWindow.AppKit.WillMiniaturizeMessage> { ; macOS 27.0+
   documentation: (none)

18. [a:swift:RealityFoundation::5848:RealityFoundation.SubsurfaceRadiusScale]
   framework: RealityFoundation   (top level)
   name: SubsurfaceRadiusScale   kind: struct
   declaration: struct public struct SubsurfaceRadiusScale { ; macOS 27.0+
   documentation: (none)

19. [a:objc:Metal:MTLDataType.h:138:MTLDataType.MTLDataTypeUChar4]
   framework: Metal   member of: MTLDataType
   name: MTLDataTypeUChar4   kind: enumCase
   declaration: enumCase MTLDataTypeUChar4 = 52, ; macOS 10.11+
   documentation: Represents a data type consisting of a vector of four unsigned character values.

20. [a:objc:Foundation:NSCharacterSet.h:317:NSMutableCharacterSet.characterSetWithContentsOfFile:]
   framework: Foundation   member of: NSMutableCharacterSet
   name: characterSetWithContentsOfFile:   kind: classMethod
   declaration: classMethod + (nullable NSMutableCharacterSet *)characterSetWithContentsOfFile:(NSString *)fName;
   documentation: Returns a mutable character set read from the bitmap representation stored in the file at a given path.

21. [a:swift:AppKit::120:AppKit.DidBeginEditingMessage]
   framework: AppKit   (top level)
   name: DidBeginEditingMessage   kind: struct
   declaration: struct public struct DidBeginEditingMessage { ; macOS 27.0+
   documentation: (none)

22. [a:swift:CoreGraphics::1325:CoreGraphics.Attributes.expansionText]
   framework: CoreGraphics   member of: Attributes
   name: expansionText   kind: var
   declaration: var public var expansionText: Swift.String? ; macOS 27.0+
   documentation: (none)

23. [a:objc:PhotosUI:PHSharedAlbumCreationViewController.h:35:PHSharedAlbumCreationConfiguration.initWithPhotoLibrary:]
   framework: PhotosUI   member of: PHSharedAlbumCreationConfiguration
   name: initWithPhotoLibrary:   kind: method
   declaration: method - (instancetype)initWithPhotoLibrary:(PHPhotoLibrary *)photoLibrary NS_DESIGNATED_INITIALIZER;
   documentation: - Parameters: - photoLibrary: The photo library in which the shared album will be created.

24. [a:swift:RealityFoundation::8433:__REAssetBundle.LoadOptions.ContentRequest]
   framework: RealityFoundation   member of: __REAssetBundle.LoadOptions
   name: ContentRequest   kind: enum
   declaration: enum public enum ContentRequest { ; macOS 10.15+
   documentation: (none)

25. [a:objc:JavaScriptCore:JSValue.h:575:JSValue.valueWithPoint:inContext:]
   framework: JavaScriptCore   member of: JSValue
   name: valueWithPoint:inContext:   kind: classMethod
   declaration: classMethod + (JSValue * _Null_unspecified)valueWithPoint:(CGPoint)point inContext:(JSContext * _Null_unspecified)context;
   documentation: @method Create a JSValue from a CGPoint. A newly allocated JavaScript object containing properties named <code>x</code> and <code>y</code>, with values from the CGPoint.

26. [a:swift:RealityFoundation::16270:RealityFoundation.AttributeCompressionType]
   framework: RealityFoundation   (top level)
   name: AttributeCompressionType   kind: enum
   declaration: enum public enum AttributeCompressionType { ; macOS 15.0+
   documentation: (none)

27. [a:swift:AppKit::2661:AppKit.DidExposeMessage.exposedRect]
   framework: AppKit   member of: DidExposeMessage
   name: exposedRect   kind: var
   declaration: var public var exposedRect: Foundation.NSRect ; macOS 27.0+
   documentation: (none)

28. [a:swift:CreateMLComponents::1032:UpdatableSupervisedTabularEstimator]
   framework: CreateMLComponents   (top level)
   name: UpdatableSupervisedTabularEstimator   kind: protocol
   declaration: protocol public protocol UpdatableSupervisedTabularEstimator<Transformer, Annotation> : CreateMLComponents.SupervisedTabularEstimator { ; macOS 13.0+
   documentation: (none)

29. [a:swift:USDKit::1557:USDKit.ValueType.color4d]
   framework: USDKit   member of: ValueType
   name: color4d   kind: var
   declaration: var public static var color4d: USDKit.USDPrim.USDKit.Attribute.USDKit.ValueType { ; macOS 27.0+
   documentation: (none)

30. [a:objc:Foundation:NSCharacterSet.h:99:NSCharacterSet.symbolCharacterSet]
   framework: Foundation   member of: NSCharacterSet
   name: symbolCharacterSet   kind: property
   declaration: property @property (readonly, class, copy) NSCharacterSet *symbolCharacterSet;
   documentation: A character set containing the characters in Unicode General Category S\*. These characters include, for example, the dollar sign (`$`) and the plus (`+`) sign.

31. [a:objc:OpenDirectory:ODNode.h:143:ODNode.setCredentialsWithRecordType:authenticationType:authenticationItems:continueItems:context:error:]
   framework: OpenDirectory   member of: ODNode
   name: setCredentialsWithRecordType:authenticationType:authenticationItems:continueItems:context:error:   kind: method
   declaration: method - (BOOL)setCredentialsWithRecordType:(ODRecordType)inRecordType authenticationType:(ODAuthenticationType)inType authenticationItems:(NSArray *)inItems continueItems:(NSArray **)outItems context:(id *) ; 
   documentation: @method setCredentialsWithRecordType:authType:authItems:outAuthItems:context:error: Allows use of other OpenDirectory types of authentications to set the credentials for an ODNode Allows the caller to use other types of authentications that are available in OpenDirectory, that may require response-request loops, etc. Not all OD plugins will support

32. [a:swift:StoreKit::2361:StoreKit.groupLevel]
   framework: StoreKit   (top level)
   name: groupLevel   kind: var
   declaration: var public var groupLevel: Swift.Int { ; macOS 13.3+
   documentation: (none)

33. [a:swift:CoreMedia::2719:CoreMedia.outputSampleTimingInfos]
   framework: CoreMedia   (top level)
   name: outputSampleTimingInfos   kind: func
   declaration: func public func outputSampleTimingInfos() throws -> [CoreMedia.CMSampleTimingInfo] ; macOS 10.15+
   documentation: (none)

34. [a:objc:InstallerPlugins:InstallerState.h:55:InstallerState.licenseAgreedLanguage]
   framework: InstallerPlugins   member of: InstallerState
   name: licenseAgreedLanguage   kind: property
   declaration: property @property (NS_NONATOMIC_IOSONLY, readonly, strong) NSString *licenseAgreedLanguage;
   documentation: @method licenseAgreedLanguage Specifies the language the language was last viewed or agreed with.

35. [a:objc:CoreWLAN:CoreWLANTypes.h:118:CWErr]
   framework: CoreWLAN   (top level)
   name: CWErr   kind: enum
   declaration: enum typedef NS_ENUM(NSInteger, CWErr) { kCWNoErr = 0, kCWEAPOLErr = 1, kCWInvalidParameterErr = -3900, kCWNoMemoryErr = -3901, kCWUnknownErr = -3902, kCWNotSupportedErr = -3903, kCWInvalidFormatErr = -390
   documentation: @typedef CWErr Error codes corresponding to the CWErrorDomain domain. kCWNoErr Success. kCWEAPOLErr EAPOL-related error. kCWInvalidParameterErr Parameter error. kCWNoMemoryErr Memory allocation failed. kCWUnknownErr Unexpected error condition encountered for which no error code exists. kCWNotSupportedErr Operation not supported. kCWInvalidFormatErr

36. [a:objc:Foundation:NSCalendar.h:519:NSCalendar.isDateInWeekend:]
   framework: Foundation   member of: NSCalendar
   name: isDateInWeekend:   kind: method
   declaration: method - (BOOL)isDateInWeekend:(NSDate *)date API_AVAILABLE(macos(10.9), ios(8.0), watchos(2.0), tvos(9.0)); ; macOS 10.9+
   documentation: This API reports if the date is within a weekend period, as defined by the calendar and calendar's locale.

37. [a:objc:Tcl:tclCompile.h:855:TclEvalObjvInternal]
   framework: Tcl   (top level)
   name: TclEvalObjvInternal   kind: function
   declaration: function MODULE_SCOPE int TclEvalObjvInternal(Tcl_Interp *interp, int objc, Tcl_Obj *const objv[], CONST char *command, int length, int flags);
   documentation: ---------------------------------------------------------------- Procedures exported by tclBasic.c to be used within the engine. ---------------------------------------------------------------- /

38. [a:swift:USDKit::5722:USDKit.ChangeList.Entry.Flags.didRemoveProperty]
   framework: USDKit   member of: ChangeList.Entry.Flags
   name: didRemoveProperty   kind: var
   declaration: var public var didRemoveProperty: Swift.Bool { ; macOS 27.0+
   documentation: (none)

39. [a:swift:Foundation::21091:Foundation.script]
   framework: Foundation   (top level)
   name: script   kind: var
   declaration: var public var script: Foundation.Locale.Foundation.Script? { ; macOS 13+
   documentation: (none)

40. [a:objc:AppKit:NSWritingToolsCoordinator.h:44:NSWritingToolsCoordinatorTextUpdateReason.NSWritingToolsCoordinatorTextUpdateReasonTyping]
   framework: AppKit   member of: NSWritingToolsCoordinatorTextUpdateReason
   name: NSWritingToolsCoordinatorTextUpdateReasonTyping   kind: enumCase
   declaration: enumCase NSWritingToolsCoordinatorTextUpdateReasonTyping, ; macOS 27.0+
   documentation: Specify this option when the changes come from the text input system.

41. [a:objc:Metal:MTLResource.h:30:MTLPurgeableState]
   framework: Metal   (top level)
   name: MTLPurgeableState   kind: enum
   declaration: enum typedef NS_ENUM(NSUInteger, MTLPurgeableState) { MTLPurgeableStateKeepCurrent = 1, MTLPurgeableStateNonVolatile = 2, MTLPurgeableStateVolatile = 3, MTLPurgeableStateEmpty = 4, } API_AVAILABLE(macos(10 ; macOS 10.11+
   documentation: @enum MTLPurgeableOption Options for setPurgeable call. MTLPurgeableStateNonVolatile The contents of this resource may not be discarded. MTLPurgeableStateVolatile The contents of this resource may be discarded. MTLPurgeableStateEmpty The contents of this are discarded. MTLPurgeableStateKeepCurrent The purgeabelity state is not changed. /

42. [a:swift:Foundation::22611:Swift.canBeConverted]
   framework: Foundation   member of: Swift
   name: canBeConverted   kind: func
   declaration: func public func canBeConverted(to encoding: Swift.String.Foundation.Encoding) -> Swift.Bool ; macOS 10.10+
   documentation: (none)

43. [a:swift:Foundation::7856:Foundation.EWOULDBLOCK]
   framework: Foundation   (top level)
   name: EWOULDBLOCK   kind: var
   declaration: var public static var EWOULDBLOCK: _DarwinFoundation1.POSIXErrorCode { ; macOS 10.10+
   documentation: (none)

44. [a:objc:MetalFX:MTLFXTemporalScaler.h:262:MTLFXTemporalScalerBase.outputOffsetY]
   framework: MetalFX   member of: MTLFXTemporalScalerBase
   name: outputOffsetY   kind: property
   declaration: property @property (nonatomic) NSUInteger outputOffsetY API_AVAILABLE(macos(27.0), ios(27.0)) API_UNAVAILABLE(visionos); ; macOS 27.0+
   documentation: The vertical offset, in pixels, of the region within the output texture to write results.

45. [a:swift:Vision::2922:DetectContoursRequest]
   framework: Vision   (top level)
   name: DetectContoursRequest   kind: struct
   declaration: struct public struct DetectContoursRequest : Vision.ImageProcessingRequest { ; macOS 15.0+
   documentation: (none)

46. [a:swift:WebKit::452:WebKit.NavigationPreferences.overrideReferrer]
   framework: WebKit   member of: NavigationPreferences
   name: overrideReferrer   kind: var
   declaration: var public var overrideReferrer: Swift.String? ; macOS 27.0+
   documentation: (none)
