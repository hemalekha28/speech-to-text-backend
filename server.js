import express from "express"
import cors from "cors"
import mongoose from "mongoose"
import multer from "multer"
import fs from "fs"
import path from "path"
import FormData from "form-data"
import fetch from "node-fetch"
import dotenv from "dotenv"

dotenv.config()

const app = express()
const PORT = 5000

// Create uploads directory if it doesn't exist
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads")
  console.log("Created uploads directory")
}

// Configure multer with better file handling
const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept audio files
    if (file.mimetype.startsWith('audio/') || file.mimetype === 'video/webm') {
      cb(null, true)
    } else {
      cb(new Error('Only audio files are allowed'), false)
    }
  }
})

app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

// Validate API key on startup
if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY environment variable is not set!")
  console.log("Please set your OpenAI API key in your .env file:")
  console.log("OPENAI_API_KEY=sk-your-key-here")
} else if (!OPENAI_API_KEY.startsWith("sk-")) {
  console.error("❌ OPENAI_API_KEY appears to be invalid (should start with sk-)")
} else {
  console.log("✅ OpenAI API key is set and appears valid")
}

mongoose
  .connect("mongodb://localhost:27017/speechtotext")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log("❌ MongoDB Error:", err))

const TranscriptionSchema = new mongoose.Schema({
  text: String,
  confidence: Number,
  method: String,
  language: String,
  duration: Number,
  createdAt: { type: Date, default: Date.now },
})

const Transcription = mongoose.model("Transcription", TranscriptionSchema)

app.get("/health", (req, res) => {
  res.json({
    message: "Server is running!",
    openai_key_configured: !!OPENAI_API_KEY,
    mongodb_connected: mongoose.connection.readyState === 1,
  })
})

app.get("/transcriptions", async (req, res) => {
  try {
    const data = await Transcription.find().sort({ createdAt: -1 })
    res.json({ success: true, data: data })
  } catch (error) {
    console.error("Error fetching transcriptions:", error)
    res.json({ success: false, message: error.message })
  }
})

app.post("/transcriptions", async (req, res) => {
  try {
    const { text, confidence = null, method = "webkit", language = null, duration = null } = req.body
    const newItem = new Transcription({ text, confidence, method, language, duration })
    const saved = await newItem.save()
    console.log(`💾 Saved ${method} transcription:`, text.substring(0, 50) + "...")
    res.json({ success: true, data: saved })
  } catch (error) {
    console.error("Error saving transcription:", error)
    res.json({ success: false, message: error.message })
  }
})

// Helper function to determine file extension based on mimetype
function getFileExtension(mimetype, originalName) {
  const mimeToExt = {
    'audio/webm': '.webm',
    'audio/wav': '.wav',
    'audio/mp3': '.mp3',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.mp4',
    'audio/m4a': '.m4a',
    'audio/ogg': '.ogg',
    'video/webm': '.webm'
  }
  
  if (mimeToExt[mimetype]) {
    return mimeToExt[mimetype]
  }
  
  // Fallback to original file extension
  if (originalName) {
    const ext = path.extname(originalName)
    if (ext) return ext
  }
  
  return '.webm' // Default fallback
}

// Enhanced Whisper API transcription route with better error handling
app.post("/transcribe-audio", upload.single("audio"), async (req, res) => {
  console.log("\n🎤 === WHISPER TRANSCRIPTION REQUEST ===")
  console.log("Timestamp:", new Date().toISOString())

  let tempFilePath = null

  try {
    // Check if file was uploaded
    if (!req.file) {
      console.log("❌ No file received in request")
      return res.json({ success: false, message: "No audio file provided" })
    }

    tempFilePath = req.file.path

    // Check API key
    if (!OPENAI_API_KEY || !OPENAI_API_KEY.startsWith("sk-")) {
      console.log("❌ Invalid or missing OpenAI API key")
      return res.json({ 
        success: false, 
        message: "Invalid or missing OpenAI API key. Please check your .env file." 
      })
    }

    console.log("📁 File details:")
    console.log("  - Filename:", req.file.filename)
    console.log("  - Original name:", req.file.originalname)
    console.log("  - Size:", req.file.size, "bytes")
    console.log("  - MIME type:", req.file.mimetype)
    console.log("  - Path:", req.file.path)
    console.log("  - File exists:", fs.existsSync(req.file.path))

    // Check file size
    if (req.file.size === 0) {
      console.log("❌ File is empty")
      return res.json({ success: false, message: "Audio file is empty" })
    }

    if (req.file.size > 25 * 1024 * 1024) {
      console.log("❌ File too large:", req.file.size, "bytes")
      return res.json({ success: false, message: "File too large. Maximum size is 25MB." })
    }

    // Determine proper file extension and create a properly named file
    const fileExt = getFileExtension(req.file.mimetype, req.file.originalname)
    const properFileName = `audio_${Date.now()}${fileExt}`
    
    console.log("🔧 Using file extension:", fileExt)
    console.log("🔧 Proper filename:", properFileName)

    // Create read stream with proper filename
    const fileStream = fs.createReadStream(req.file.path)
    
    // Prepare form data for OpenAI with better configuration
    const formData = new FormData()
    formData.append("file", fileStream, {
      filename: properFileName,
      contentType: req.file.mimetype || "audio/webm",
    })
    formData.append("model", "whisper-1")
    
    // Don't force language - let Whisper auto-detect for better results
    // formData.append("language", "en") // Comment this out for auto-detection
    
    formData.append("response_format", "verbose_json")
    formData.append("temperature", "0")

    console.log("🌐 Calling OpenAI Whisper API...")

    // Add timeout to the fetch request
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60000) // 60 second timeout

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    console.log("📡 OpenAI API Response:")
    console.log("  - Status:", response.status)
    console.log("  - Status Text:", response.statusText)
    console.log("  - OK:", response.ok)

    if (!response.ok) {
      const errorText = await response.text()
      console.error("❌ OpenAI API Error Response:", errorText)

      let errorMessage = `OpenAI API error: ${response.status} ${response.statusText}`

      try {
        const errorJson = JSON.parse(errorText)
        if (errorJson.error && errorJson.error.message) {
          errorMessage = errorJson.error.message
          
          // Provide more specific error messages
          if (errorMessage.includes("audio")) {
            errorMessage += " - Please ensure the audio file is valid and not corrupted."
          }
          if (errorMessage.includes("rate limit")) {
            errorMessage += " - Please wait a moment before trying again."
          }
        }
      } catch (e) {
        console.log("Error parsing error response as JSON")
      }

      return res.json({ success: false, message: errorMessage })
    }

    const result = await response.json()
    console.log("✅ OpenAI API Success Response:")
    console.log("  - Text length:", result.text?.length || 0)
    console.log("  - Language:", result.language)
    console.log("  - Duration:", result.duration)
    console.log("  - Text preview:", result.text?.substring(0, 100) + "...")

    if (result.text && result.text.trim()) {
      // Save to database
      const newItem = new Transcription({
        text: result.text.trim(),
        confidence: null,
        method: "whisper",
        language: result.language || "unknown",
        duration: result.duration || null,
      })

      const saved = await newItem.save()
      console.log("💾 Saved to database with ID:", saved._id)

      res.json({
        success: true,
        transcript: result.text.trim(),
        language: result.language,
        duration: result.duration,
        segments: result.segments || [],
        id: saved._id
      })

      console.log("✅ Successfully processed Whisper transcription")
    } else {
      console.log("❌ No text in OpenAI response or empty text")
      res.json({ 
        success: false, 
        message: "No transcription found in audio. The audio might be too quiet, corrupted, or contain no speech." 
      })
    }
  } catch (error) {
    console.error("💥 === TRANSCRIPTION ERROR ===")
    console.error("Error type:", error.constructor.name)
    console.error("Error message:", error.message)
    console.error("❌ Error in transcription:", error);
    if (error.name === 'AbortError') {
      console.error("Request timed out")
      res.json({ success: false, message: "Transcription request timed out. Please try with a shorter audio file." })
    } else {
      console.error("Error stack:", error.stack)
      res.json({ success: false, message: `Transcription error: ${error.message}` })
    }
  } finally {
    // Clean up file in finally block to ensure it always happens
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath)
        console.log("🗑️ Cleaned up temporary file")
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError)
      }
    }
  }

  console.log("=== END WHISPER TRANSCRIPTION REQUEST ===\n")
})

// New endpoint to check Whisper API connectivity
app.get("/test-whisper", async (req, res) => {
  try {
    if (!OPENAI_API_KEY || !OPENAI_API_KEY.startsWith("sk-")) {
      return res.json({ 
        success: false, 
        message: "OpenAI API key not configured properly" 
      })
    }

    // Test API connectivity with a simple request to models endpoint
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    })

    if (response.ok) {
      res.json({ 
        success: true, 
        message: "OpenAI API connection successful",
        whisper_available: true
      })
    } else {
      const errorText = await response.text()
      res.json({ 
        success: false, 
        message: `API connection failed: ${response.status} ${response.statusText}`,
        details: errorText
      })
    }
  } catch (error) {
    res.json({ 
      success: false, 
      message: `Connection test failed: ${error.message}` 
    })
  }
})

app.delete("/transcriptions", async (req, res) => {
  try {
    const { id } = req.query
    if (!id) {
      return res.json({ success: false, message: "ID is required" })
    }
    
    const deleted = await Transcription.findByIdAndDelete(id)
    if (!deleted) {
      return res.json({ success: false, message: "Transcription not found" })
    }
    
    res.json({ success: true, message: "Deleted successfully" })
  } catch (error) {
    res.json({ success: false, message: error.message })
  }
})

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.json({ 
        success: false, 
        message: 'File too large. Maximum size is 25MB.' 
      })
    }
  }
  
  console.error('Unhandled error:', error)
  res.json({ 
    success: false, 
    message: 'An unexpected error occurred' 
  })
})

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
  console.log("📋 Endpoints:")
  console.log("  - GET  /health")
  console.log("  - GET  /test-whisper")
  console.log("  - GET  /transcriptions")
  console.log("  - POST /transcriptions")
  console.log("  - POST /transcribe-audio")
  console.log("  - DELETE /transcriptions?id=<id>")

  if (!OPENAI_API_KEY) {
    console.log("\n⚠️  WARNING: OpenAI API key not configured!")
    console.log("   Whisper transcription will not work.")
    console.log("   Please set OPENAI_API_KEY in your .env file.")
  }
})