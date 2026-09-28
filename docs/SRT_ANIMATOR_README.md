# SRT Animator - Enhanced Caption Animation System

## Overview

SRT Animator is a powerful new feature for CompX Orbit Premiere that transforms standard SRT subtitle files into animated text sequences with multi-language support and professional animation styles.

## Features

### 🎬 Multiple Animation Styles
- **Fade In/Out** - Simple and elegant fade transitions
- **Slide Up** - Text slides up from the bottom
- **Bounce** - Bouncy scale animation for dynamic effect
- **Typewriter** - Character-by-character text reveal
- **Glitch** - Digital glitch effect with RGB split
- **Neon Glow** - Neon-style glow effect
- **Karaoke** - Word-by-word highlight animation

### 🌍 Multi-Language Support
- **RTL/LTR Auto-Detection** - Automatically detects text direction
- **Language Detection** - Supports Arabic, Chinese, Russian, Hebrew, Hindi, Thai, Korean, Japanese, and Latin scripts
- **Font Optimization** - Language-appropriate font selection and rendering

### 🎨 Advanced Text Styling
- Custom font families and sizes
- Text stroke and outline effects
- Background colors with opacity control
- Glow and shadow effects
- Adjustable positioning and spacing

## How to Use

### 1. Access SRT Animator
- Open the CompX Orbit Premiere extension
- Navigate to the **CAP** (Captions) panel
- Click the **🎬 SRT Animator** button in the empty state actions

### 2. Import SRT File
- **Drag & Drop**: Drag your SRT or VTT file directly into the upload zone
- **Browse**: Click "Browse Files" to select a file from your computer
- Supported formats: `.srt`, `.vtt`

### 3. Select Animation Style
- Browse through the available animation styles
- Click on a style card to select it
- Preview the style description and details
- Styles show mini-previews for easy selection

### 4. Preview Your Captions
- See a real-time preview of your animated captions
- Navigate through caption frames with Previous/Next buttons
- Use the Play button for continuous preview
- Caption text is displayed below the preview

### 5. Export to Premiere
- Click "Export to Premiere" to process your captions
- The system automatically:
  - Processes each caption with the selected animation style
  - Generates PNG sequences for smooth animation
  - Creates organized bin structure in Premiere
  - Places animated clips on the timeline

## Technical Details

### File Structure
```
CompX Orbit/
├── Animated Captions/
│   └── Run_YYYY-MM-DD-HH-MM-SS/
│       ├── Caption_1_arabic/
│       ├── Caption_2_latin/
│       └── ...
```

### Animation Processing
- Each caption is processed individually
- PNG sequences are generated at specified FPS (default: 10-15 fps)
- Frame count depends on caption duration and animation style
- All processing happens locally for privacy and speed

### Language Support Matrix

| Language | Script | RTL/LTR | Support |
|----------|--------|---------|---------|
| English | Latin | LTR | ✅ Full |
| Arabic | Arabic | RTL | ✅ Full |
| Chinese | Han | LTR | ✅ Full |
| Russian | Cyrillic | LTR | ✅ Full |
| Hebrew | Hebrew | RTL | ✅ Full |
| Hindi | Devanagari | LTR | ✅ Full |
| Thai | Thai | LTR | ✅ Full |
| Korean | Hangul | LTR | ✅ Full |
| Japanese | Japanese | LTR | ✅ Full |

## Customization

### Animation Settings
You can customize animation parameters:

```javascript
// In the SRT Animator module
SrtAnimator.updateSettings({
  fontFamily: 'Arial',
  fontSize: 72,
  fontWeight: 'bold',
  color: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0.75,
  positionY: 0.85,
  fps: 10,
  duration: 0.25
});
```

### Adding Custom Styles
Add new animation styles to the `ANIMATION_STYLES` array in `srtAnimator.js`:

```javascript
{
  id: 'custom-style',
  label: 'Custom Style',
  description: 'Your custom animation',
  defaultSettings: {
    animation: 'custom',
    duration: 0.3,
    fps: 12,
    // ... other settings
  }
}
```

## Integration with Existing Features

SRT Animator integrates seamlessly with existing CompX Orbit features:

- **Auto Captions**: Can be used alongside AI-generated captions
- **Silence Cutter**: Works with silence-removed audio
- **Motion Engine**: Compatible with motion effects
- **Beat Sync**: Can be combined with beat-synchronized editing

## Performance Considerations

- **Processing Time**: Depends on caption count and animation complexity
- **File Size**: PNG sequences increase project size proportionally
- **RAM Usage**: Temporary RAM usage during PNG generation
- **Timeline Performance**: Animated clips may impact timeline scrubbing

## Troubleshooting

### Common Issues

**Issue**: SRT file not importing
- **Solution**: Ensure file is valid SRT/VTT format with proper timestamps

**Issue**: Animation not appearing in Premiere
- **Solution**: Check that video track 2 exists and is accessible

**Issue**: Text direction incorrect
- **Solution**: System auto-detects direction, but you can manually override settings

**Issue**: Export fails
- **Solution**: Ensure adequate disk space and write permissions

## System Requirements

- **Premiere Pro**: 2022 or later (for caption track API support)
- **RAM**: 8GB minimum, 16GB recommended for complex projects
- **Disk Space**: 500MB minimum for temp files during processing
- **Display**: 1920x1080 recommended for full preview experience

## Future Enhancements

Planned features for future updates:

- [ ] Additional animation styles (3D transforms, particle effects)
- [ ] Batch processing of multiple SRT files
- [ ] Custom font upload and management
- [ ] Animation templates and presets
- [ ] Direct After Effects composition export
- [ ] Real-time preview in Premiere panel

## Credits

SRT Animator is built on top of the existing MachiCut caption system and extends it with advanced animation capabilities and multi-language support.

## Support

For issues, feature requests, or questions:
- Check the main CompX Orbit documentation
- Contact support through the CompX Orbit interface
- Report bugs through the built-in diagnostic system

---

**Version**: 1.0.0  
**Last Updated**: 2026-08-23  
**Compatibility**: CompX Orbit Premiere 1.x+