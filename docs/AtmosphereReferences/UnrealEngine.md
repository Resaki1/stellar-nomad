Sky Atmosphere Model
Simulating the sky and atmosphere requires several properties that mimic the look and feel of a real-world atmosphere. These properties can be used to define the look of the sky and atmosphere by scattering light in an appropriate and accurate manner. By default, the Sky Atmosphere component represents the Earth.

For an Earth-like planet, the atmosphere is made up of multiple layers of gasses. They themselves are made up of particles and molecules that have their own shape, size and density. When photons (or light energy) enter the atmosphere and collide with the particles and molecules there, they are either scattered (reflected) or absorbed (see below).

Particle Light Interaction
(1) Incident Light from the Sun; (2) Particles in the Atmosphere; (3) Redirected Light Energy.

The Sky Atmosphere system simulates absorption with Mie scattering and Rayleigh scattering. These scattering effects enable the sky to appropriately change colors during time-of-day transitions by simulating how the incident light interacts with particles and molecules in the atmosphere.


The sky color changes depending on the time-of-day simulation when using the Sky Atmosphere component.

Rayleigh Scattering
The interaction of light with smaller particles (such as air molecules) results in Rayleigh scattering. This type of scattering is highly dependent on the light wavelength. For instance, in the Earth's sky, blue scatters more than other colors, giving the sky its blue color during the daytime. However, at sunset, it appears red because light rays need to travel further in the atmosphere. After long distances, all blue light is scattered away before other colors, resulting in colorful sunsets full of yellow, orange, and red colors.

Rayleigh Scattering
(1) Incident light; (2) Small particles in the atmosphere; (3) Rayleigh scattered light energy.

In an Earth-like atmosphere, when sunlight interacts with small particles (1) in the atmosphere (2), Rayleigh scattering happens throughout the atmosphere. The upper atmosphere is less dense compared to the lower atmosphere near the Earth's surface (3).

Rayleigh Atmosphere Interaction
Increasing or decreasing the density of particles in the atmosphere causes light to scatter more or less.

Drag the slider to see the effects of decreasing and increasing the Rayleigh Scattering Scale. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing the Rayleigh Scattering Scale. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing the Rayleigh Scattering Scale. (Left to right, 1–3)

Drag the slider to see the effects of decreasing and increasing the Rayleigh Scattering Scale. (Left to right, 1–3)

Decreased scattering causes light to scatter less through the atmosphere. This is 10x less dense than Earth's atmosphere.
This is representative of an Earth-like atmospheric density.
Increased scattering allows light to scatter more through the atmosphere. This is 10x more dense than Earth's atmosphere.
Mie Scattering
The interaction of light with larger particles—such as those from dust, pollen, or air pollution—suspended in the atmosphere results in Mie scattering. These particles are referred to as aerosols and can be caused naturally or by human activity. Incident light that follows the Mie scattering theory usually absorbs light, causing the clarity of the sky to appear hazy by occluding light. Light also usually scatters more forward, resulting in bright halos around the light's source, such as around the sun disk in the sky.

Mie Scattering
(1) Incident light; (2) Large particles in the atmosphere; (3) Mie-scattered light energy.

Increasing or decreasing the aerosol density causes more or less clarity in the sky, contributing to how hazy it looks.

Drag the slider to see the effects of decreasing and increasing the Mie Scattering Scale. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing the Mie Scattering Scale. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing the Mie Scattering Scale. (Left to right, 1–3)

Drag the slider to see the effects of decreasing and increasing the Mie Scattering Scale. (Left to right, 1–3)

Decreased particle density allows the sky to appear more clearly. It has less haze and light is scattered less directionally.
Default Mie scattering scale.
Increased particle density causes the sky to become occluded. It also causes the sky to appear hazy with the strong forward scattering lob around the incident light direction.
Mie Phase
The Mie Phase controls how uniformly light scatters when interacting with larger aerosol particles in the atmosphere. With Mie scattering, light usually scatters more forward, resulting in bright halos around the light's source, such as around the sun disk in the sky.

Mie Phase
(1) Incident Light; (2) Larger particles in the atmosphere; (3) Stronger Mie-scattered light energy.

Use the Mie Anisotropy property to control how uniformly Mie scattering happens across the atmosphere.

Drag the slider to see the effects of decreasing and increasing the Mie Anisotropy of the atmosphere. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing the Mie Anisotropy of the atmosphere. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing the Mie Anisotropy of the atmosphere. (Left to right, 1–3)

Drag the slider to see the effects of decreasing and increasing the Mie Anisotropy of the atmosphere. (Left to right, 1–3)

Decreasing the Mie Anisotropy scatters light more uniformly across the atmosphere. This example is using a value of 0.
Default settings mimic an Earth-like atmosphere. This example is using a value of 0.8.
Increasing the Mie Anisotropy scatters light more directionally causing it to tighten around the light source. This example is using a value of 0.9.
Atmospheric Absorption
The amount and colors absorbed are controlled using the Absorption Scale and Absorption color picker properties. The examples below demonstrate removing a single RGB color through the increased Absorption Scale.

Drag the slider to see the effects of decreasing and increasing the Absorption Scale of the atmosphere. (Left to right, 1-3)Drag the slider to see the effects of decreasing and increasing the Absorption Scale of the atmosphere. (Left to right, 1-3)Drag the slider to see the effects of decreasing and increasing the Absorption Scale of the atmosphere. (Left to right, 1-3)

Drag the slider to see the effects of decreasing and increasing the Absorption Scale of the atmosphere. (Left to right, 1-3)

No atmospheric absorption.
Default Earth Ozone absorption scale.
Increased Ozone absorption scale.
The amount and colors absorbed are controlled using the Absorption Scale and Absorption color picker properties. The examples below demonstrate removal of a single RGB color through an atmosphere with increased absorption.

 	 	 
Green Absorbed	Red Absorbed	Blue Absorbed
Green Absorbed	Red Absorbed	Blue Absorbed
Absorption of some colors may not be as noticeable during different times of day due to the way light scatters through the atmosphere.

Altitude Distribution
The Sky Atmosphere component enables you to control the atmosphere from not only a ground perspective but also from an aerial and space one. This means that you can effectively define the curvature of your world so that transitioning from ground to sky to space feels and looks like a real-world atmosphere.

Use the following properties to achieve this use:

Ground Radius to define the planet's size.

Atmospheric Height to define the height of the atmosphere above which we stop evaluating light interactions with the atmosphere.

Rayleigh Exponential Distribution to define the altitude (in kilometers) at which Rayleigh scattering effect is reduced to 40% due to reduced density.

Mie Exponential Distribution to define the altitude (in kilometers) at which Mie scattering effect is reduced to 40% due to reduced density.

Drag the slider to see the effects of decreasing and increasing Rayleigh height of the atmosphere. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing Rayleigh height of the atmosphere. (Left to right, 1–3)Drag the slider to see the effects of decreasing and increasing Rayleigh height of the atmosphere. (Left to right, 1–3)

Drag the slider to see the effects of decreasing and increasing Rayleigh height of the atmosphere. (Left to right, 1–3)

Rayleigh Atmosphere Height is 0.8 kilometers.
Default Rayleigh Atmosphere Height of 8 kilometers.
Rayleigh Atmosphere Height is 80 kilometers.
Artistic Direction
Additionally, the Sky Atmosphere component supports artistic control when designing the look of your project.

Aerial Perspective Scale
The Aerial Perspective View Distance Scale property scales distances from the view to surfaces to make them look thicker when viewed from a high enough distance above the ground surface.

Drag the slider to change the Aerial Perspective View Distance Scale property. (Left to right, 1-3)Drag the slider to change the Aerial Perspective View Distance Scale property. (Left to right, 1-3)Drag the slider to change the Aerial Perspective View Distance Scale property. (Left to right, 1-3)

Drag the slider to change the Aerial Perspective View Distance Scale property. (Left to right, 1-3)

Some atmospheric properties were set up for this scene.
The same scene with the Aerial Perspective View Distance Scale increased slightly.
The same scene with Aerial Perspective View Distance Scale doubled.
Exponential Height Fog
Mie scattering is a component of the atmosphere and is a height fog simulation in itself, meaning you can already use it to create height fog in your scene without using the Exponential Height Fog component (see below).

Sky Atmosphere's Height Fog
Sky Atmosphere | with Exponential Height Fog

Sky Atmosphere's Height FogSky Atmosphere | with Exponential Height Fog
Height fog produced from the Sky Atmosphere component without Exponential Height Fog component.

Should your project require Exponential Height Fog, it can be enabled in the Project Settings under the Rendering category by setting Support Sky Atmosphere Affecting Height Fog. Contribution from height fog is additive; it applies sky atmosphere height fog on top of the existing faked colors provided by the Exponential Height Fog component. To have Sky Atmosphere component affect and influence Exponential Height Fog, you'll need to set Fog Inscattering Color and Directional Inscattering Color to Black using their respective color pickers.

Set Fog Inscattering Color and Directional Inscattering Color to Black using their respective color pickers
With these set, you can use the Sky Atmosphere's Height Fog Contribution setting under the Art Direction category to apply artistic control over how much light coming through the atmosphere affects the height fog. Below is an example of height fog contribution being adjusted.

Drag the slider to see the height fog contribution increase and decrease its contribution to the Sky Atmosphere component. (Left to right, 1-3)Drag the slider to see the height fog contribution increase and decrease its contribution to the Sky Atmosphere component. (Left to right, 1-3)Drag the slider to see the height fog contribution increase and decrease its contribution to the Sky Atmosphere component. (Left to right, 1-3)

Drag the slider to see the height fog contribution increase and decrease its contribution to the Sky Atmosphere component. (Left to right, 1-3)

Default height fog contribution from the Sky Atmosphere component.
Half height fog contribution (0.5) from the Sky Atmosphere component.
Double height fog contribution (2.0) from the Sky Atmosphere Component.
Sky Rendering Options
The sky and aerial perspective is rendered on screen using ray marching. However, doing so for each pixel can be expensive, especially with today's standard pushing towards 4K or 8K resolution. That is why the sky is evaluated in a few lookup tables (LUTs) at low resolution. Those LUTs are:

By default, all of these LUTs are all evaluated, but using the examples below you can determine the needs for your own projects.

Type of LUT Used	Description
FastSkyViewLUT	Stores a latitude/longitude texture of the ray ray marched sky luminance around a point of view. It is applied on the sky pixels only.
AerialPerspectiveLUT	Stores the transmittance and scattered luminance into froxel (camera frustum voxel). This is used to apply aerial perspective on opaque and transparent meshes**.
MultipleScatteringLUT	During ray marching, used to evaluate the multiple scattering contributions.
TransmittanceLUT	During ray marching, used to evaluate the remaining illuminance from the sun light for any position within the atmosphere and on the planet.
DistanceSkyLightLUT	Stores non-occluded luminance after a scatter event with a uniform phase function.
Many of these settings allow you to control the LUT's performance and visual quality for your project. For additional details about them, see the Sky Atmosphere Properties page.

Rendering the Sky using a Skydome Mesh
For some projects, you will want to position the skydome mesh around the world, enabling artists to control the way the sky is composited with clouds, stars, sun and any other celestial bodies.

To set up a skydome mesh to work with the Sky Atmosphere component, you'll need to set the following in its Material:

Blend Mode: Opaque
Shading Model: Unlit
The sky material is rendered as the last opaque mesh during the base pass, meaning that aerial perspective will not be applied on it to avoid double contribution. However, height fog and volumetric fog will continue to be applied, if used.

In this material, you will have the freedom to compose the sky, sun disk, clouds and aerial perspective. Also, you will have to compute lighting on the clouds and other elements in the sky. Several Material Expressions can be used to achieve this in your materials. You can find them by searching the term "SkyAtmosphere" in the Material Editor.

Customized Sky Material
When creating your own sky material, which has customized clouds, planets, sun, or other object, you should enable the Is Sky flag in the Material advanced properties. However, keep in mind that it disables contribution from aerial perspective (atmospheric fog) of the Sky Atmosphere component, but does apply height and volumetric fog to the scene from the Exponential Height Fog component.

For additional information about these Material Expressions, see the Sky Atmosphere Properties page.

The shape of the skydome mesh is important when using some of these expressions since they will drive evaluation of those values. For example, if you use the functions to evaluate lighting on clouds, you can assume the skydome pixel world position represents the cloud world position in the atmosphere.

Time of Day Example Level
A working example template map demonstrating a skydome mesh with a material using the Sky Atmosphere Material Expressions is available within Unreal Engine.

Time of Day Example Level
This Level is located in the Engine Content folder under Engine/Content/Maps/Templates, or you can use the main menu to create a new level and select the TimeOfDay_Default Level.

Planetary Atmospheres Viewed from Space
In addition to creating beautiful atmospheres from a planet's surface, the Sky Atmosphere system is capable of creating a planetary atmosphere viewed from space. Without any special setup, you can even move seamlessly from the planet's surface through the atmosphere to outer space.


This video uses assets and materials that are not part of the Sky Atsmosphere system, such as the star field and meshes that represent the planet surface.

The following properties are useful when setting up a planet to be viewed from outer space (or even just a very high altitude):

Ground Radius define the size of your planet (measured in kilometers).
Atmosphere Height defines the height of the atmosphere above the planet's surface (measured in kilometers).
Rayleigh Exponential Distribution defines the altitude at which the Rayleigh effect is reduced to 40%.
Below are some examples using demonstrating different planetary atmospheres using variations of these three properties:

 	 	 	 	 
undefined
undefined
undefined
undefined
undefined
Ground Radius: 6360 km	Ground Radius: 300 km	Ground Radius: 300 km	Ground Radius: 300 km	Ground Radius: 300 km
Atmosphere Height: 100 km	Atmosphere Height: 100km	Atmosphere Height: 100 km	Atmosphere Height: 100 km	Atmosphere Height: 300kn
Rayleigh Distribution: 8 km	Rayleigh Distribution: 8 km	Rayleigh Distribution: 2 km	Rayleigh Distribution: 32 km	Rayleigh Distribution: 32 km
Click images for full size.

Moving the Atmosphere
The Sky Atmosphere component is freely movable within Level using the selectable Transform Mode. Choose from the following options:

Planet Top at Absolute World Position places the top ground level of the atmosphere at the world origin coordinates (0,0,0) in the scene. The Sky Atmosphere is not movable when this option is selected.
Planet Top at Component Transform places the top ground level of the atmosphere relative to the component's transform origin. Moving the transform of the Sky Atmosphere component, or one that it is a child of, moves the atmosphere within the level.
Planet Center at Component Transform places the atmosphere centered to the component's transform origin. Moving the transform of the Sky Atmosphere component, or one that it is a child of, moves the atmosphere within the level.
The Sky Atmosphere component can be parented to objects in the scene, such as a planet mesh.

Atmosphere Transmittance
Light transmittance through the atmosphere is optimized for ground-level views; a single transmittance is evaluated for the top of the planet, but for a planetary view, the transmittance should be evaluated per pixel for the atmosphere terminator to look correct. This also enables the atmosphere to cast shadows on nearby moons, or other celestial objects.

Transmittance: | Look-up Table (LUT)
Transmittance: | Per Pixel

Transmittance: | Look-up Table (LUT)Transmittance: | Per Pixel
Per pixel transmittance also enables shadowing of objects in outer space, such as nearby moons and other celestial objects, according to properties set on the Sky Atmosphere component.

Transmittance Disabled
Transmittance Enabled

Transmittance DisabledTransmittance Enabled
Enable per pixel transmittance on your Directional Light by ticking the checkbox for Per Pixel Atmosphere Transmittance.

Moving from Ground to Outer Space
The Sky Atmosphere system is optimized for scenes that are on ground level. However, there is nothing preventing you from traveling from the ground to a high aerial view, or even outer space. While the transition through the atmosphere should be seamless—without a noticeable transition—from the look-up tables (LUTs) to per pixel tracing, you may sometimes experience a hitch or when this happens.

This optimization can be disabled by setting the following console command values to 0:

r.SkyAtmosphere.FastSkyLUT
r.SkyAtmosphere.AerialPerspectiveLUT.FastApplyOnOpaque
Once disabled, it is worth noting that you may encounter the following issues. These are some suggestions to help you work around them for your project to find a balance that best fits your project.

A high-frequency pattern can become visible when it should be absorbed by temporal anti-aliasing (TAA). However, when moving the camera very fast, there is a camera cut that happens—restarting TAA—so it is visible in space views.

Due to the way samples count is based on distance, samples become visibly large (as circles) in the atmosphere. Visibility of the samples is a side-effect of the density of medium in the atmosphere being higher, and very concentrated, close to the ground, which is a typical ray marching issue. You can solve this in a couple of ways:

Trade performance for quality increase by increasing the number of samples with r.SkyAtmosphere.SampleCountMax or r.SkyAtmosphere.DistanceToCountMax.
Set up logic to adjust and tweak atmospheric properties when in outer space to have less particles near the ground, making them more uniform and height distributed.